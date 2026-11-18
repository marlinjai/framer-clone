// src/lib/renderer/customCode/CustomCodeIsland.tsx
//
// A sandboxed custom code block on a published page, once the server accepted it
// (applyCustomCode: a live blob of this site, one of the page's first four blocks,
// every declared state where the block stands). Plan
// docs/plans/2026-11-02-sandboxed-custom-code.md, "Per surface", slice C3.
//
// The server renders exactly what C2's published element renders: the box, with
// `data-fc-custom-code` and its children, which are the fallback. So does the
// first client render, and hydration agrees. Then the island adds its block to the
// registry, where the broker (fetched by BehaviourIsland only on a page with a
// block) creates the frame inside the box. The fallback stays until the frame says
// hello, and comes back for good on any failure: no hello, a second hello or load,
// a frozen frame, focus theft, the broker never arriving, or the runtime stopping.
// Without JavaScript the fallback is all there is.
//
// The island draws no frame itself and reads nothing of the frame. Its props are
// the server's: the box's tag and attributes (through the render gate), the trace
// and the block.

'use client';

import React, { useEffect, useRef, useState } from 'react';
import { addBlock, type IslandBlock } from '@/lib/customCode/registry';
import { CUSTOM_CODE_ATTR } from '@/lib/customCode/customCode';

export interface CustomCodeIslandProps {
  /** The box's tag; never a void tag (customCodeBoxTag draws a container of the content it stands in for one). */
  tag: string;
  /** The box's attributes, through the render gate and without `customCode`. */
  domProps: Record<string, unknown>;
  /** The first characters of the hash, as C2's element writes them. */
  trace: string;
  block: IslandBlock;
  /** The fallback. */
  children?: React.ReactNode;
}

type Phase = 'waiting' | 'shown' | 'failed';

export default function CustomCodeIsland({ tag, domProps, trace, block, children }: CustomCodeIslandProps) {
  const box = useRef<HTMLElement>(null);
  const [phase, setPhase] = useState<Phase>('waiting');

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    let failed = false;
    const remove = addBlock({
      el,
      block,
      settle: (shown) => {
        // A failure is for good: nothing brings the frame back in this page view.
        if (failed) return;
        if (!shown) failed = true;
        setPhase(shown ? 'shown' : 'failed');
      },
    });
    return remove;
  }, [block]);

  return React.createElement(
    tag,
    { ...domProps, ref: box, [CUSTOM_CODE_ATTR]: trace, 'data-fc-custom-code-state': phase },
    phase === 'shown' ? null : children,
  );
}
