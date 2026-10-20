// A generated page with a stock photo, end to end through the published-site
// renderer: the validator collects the image's query, the route writes the
// Unsplash photo and its credit into the node, and the published HTML carries
// the hotlinked images.unsplash.com URL plus the credit attributes.
import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { getSnapshot } from 'mobx-state-tree';
import ComponentModel from '@/models/ComponentModel';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { applyStockPhotos } from '@/lib/ai/pageGen/stockImages';
import { breakpointKeyMap, toEditorSnapshot } from '@/lib/ai/pageGen/apply';
import { componentSnapshotToNode } from '../snapshotToComponentNode';
import { renderComponentNode } from '../renderComponentNode';

describe('published render of a generated stock photo', () => {
  it('emits the Unsplash URL, the alt text and the photographer credit', () => {
    const bps = [{ id: 'bp-d', label: 'Desktop', minWidth: 1280 }];
    const out = validateGeneration(
      { nodes: [{ type: 'section', children: [{ type: 'img', props: { imageQuery: 'river at dawn', alt: 'Fluss im Morgenlicht' } }] }] },
      { breakpoints: deriveBreakpointKeys(bps) },
    );
    if (!out.ok) throw new Error(out.errors.join('; '));
    const [request] = out.result.imageRequests;
    const nodes = applyStockPhotos(out.result.nodes, [
      {
        nodeId: request.nodeId,
        src: 'https://images.unsplash.com/photo-123?ixid=x&w=480',
        downloadLocation: 'https://api.unsplash.com/photos/123/download',
        credit: {
          photoId: '123',
          photographerName: 'Ana Example',
          photographerUrl: 'https://unsplash.com/@ana?utm_source=lumitra&utm_medium=referral',
          unsplashUrl: 'https://unsplash.com/?utm_source=lumitra&utm_medium=referral',
        },
      },
    ]);
    // Through the editor model (what Save persists) and the publish adapter.
    const model = ComponentModel.create(toEditorSnapshot(nodes[0], breakpointKeyMap(bps)));
    const html = renderToStaticMarkup(<>{renderComponentNode(componentSnapshotToNode(getSnapshot(model)))}</>);
    expect(html).toContain('src="https://images.unsplash.com/photo-123?ixid=x&amp;w=480"');
    expect(html).toContain('alt="Fluss im Morgenlicht"');
    expect(html).toContain('title="Photo by Ana Example on Unsplash"');
    expect(html).toContain('data-credit-url="https://unsplash.com/@ana?utm_source=lumitra&amp;utm_medium=referral"');
    expect(html).not.toContain('imageQuery');
  });
});
