// The published island of a custom code block (slice C3): the server's markup on the first
// render, the fallback until hello, the fallback for good after any failure, and the block
// handed to the broker through the registry.

import React from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import CustomCodeIsland from '../CustomCodeIsland';
import { serveBlocks, type BlockHandle, type IslandBlock } from '@/lib/customCode/registry';

const block: IslandBlock = {
  src: `https://run.box.test/box/0b9e2f4a-1c2d-4e5f-8a9b-0c1d2e3f4a5b/${'a'.repeat(64)}`,
  title: 'Calculator', reads: [], writes: [], emits: [], sizing: 'fixed', interactive: true, states: {},
};

const island = () => (
  <CustomCodeIsland tag="section" domProps={{ className: 'box', id: 'calc' }} trace="aaaaaaaaaaaa" block={block}>
    <p>Fallback</p>
  </CustomCodeIsland>
);

let stopServing: (() => void) | undefined;
afterEach(() => {
  stopServing?.();
  stopServing = undefined;
  cleanup();
});

describe('CustomCodeIsland', () => {
  it('renders on the server exactly the box, its trace and the fallback', () => {
    expect(renderToStaticMarkup(island())).toBe('<section class="box" id="calc" data-fc-custom-code="aaaaaaaaaaaa" data-fc-custom-code-state="waiting"><p>Fallback</p></section>');
  });

  it('hands its block to the broker, drops the fallback at hello and brings it back for good on a failure', () => {
    const handles: BlockHandle[] = [];
    let removed = 0;
    stopServing = serveBlocks((handle) => {
      handles.push(handle);
      return () => {
        removed += 1;
      };
    });
    const { container, unmount } = render(island());
    expect(handles).toHaveLength(1);
    expect(handles[0].block).toBe(block);
    expect(handles[0].el).toBe(container.querySelector('section'));
    act(() => handles[0].settle(true));
    expect(container.textContent).toBe('');
    act(() => handles[0].settle(false));
    expect(container.textContent).toBe('Fallback');
    expect(container.querySelector('section')?.getAttribute('data-fc-custom-code-state')).toBe('failed');
    act(() => handles[0].settle(true));
    expect(container.textContent).toBe('Fallback');
    unmount();
    expect(removed).toBe(1);
  });

  it('waits for a broker that arrives later, and keeps the fallback when it stops', () => {
    const { container } = render(island());
    const handles: BlockHandle[] = [];
    stopServing = serveBlocks((handle) => {
      handles.push(handle);
      return () => handle.settle(false);
    });
    expect(handles).toHaveLength(1);
    act(() => handles[0].settle(true));
    expect(container.textContent).toBe('');
    act(() => stopServing?.());
    stopServing = undefined;
    expect(container.textContent).toBe('Fallback');
  });
});
