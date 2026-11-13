// The tags of a page's head items (src/lib/site/headItems.ts, slice H2 of
// docs/plans/2026-11-02-theme-and-head.md). Rendered from SERVER components: React hoists a
// `meta` or `link` into the real <head>, and only those two, so a JSON-LD item stays where it
// is rendered, in the body, as the business JSON-LD does.
//
// Every attribute is written from the item `parseHeadItem` returned, never from stored text,
// and the element names are constants: the kind has no way to say anything else. JSON-LD goes
// through `jsonLdScriptText`, which escapes `<`, so no value can close the script element.
//
// These must render ABOVE any Suspense boundary: a suspended subtree flushes a hoisted tag
// into the body. The route has no boundary today, and test/behaviour/headItems.spec.ts reads
// raw HTML from a real build, so one added later fails a test and not a site's verification.

import React from 'react';
import type { HeadItem } from '@/lib/site/headItems';
import { jsonLdScriptText } from '@/lib/site/publishedHead';

export function HeadItemTags({ items }: { items: readonly HeadItem[] }): React.ReactElement | null {
  if (items.length === 0) return null;
  return (
    <>
      {items.map((item, index) => {
        switch (item.kind) {
          case 'meta':
            return <meta key={index} name={item.name} content={item.content} />;
          case 'property':
            return <meta key={index} property={item.property} content={item.content} />;
          case 'link':
            return (
              <link
                key={index}
                rel={item.rel}
                href={item.href}
                {...(item.hreflang !== undefined ? { hrefLang: item.hreflang } : {})}
                {...(item.type !== undefined ? { type: item.type } : {})}
                {...(item.title !== undefined ? { title: item.title } : {})}
              />
            );
          case 'jsonld':
            return (
              <script
                key={index}
                type="application/ld+json"
                data-head-jsonld=""
                dangerouslySetInnerHTML={{ __html: jsonLdScriptText(item.data) }}
              />
            );
        }
      })}
    </>
  );
}
