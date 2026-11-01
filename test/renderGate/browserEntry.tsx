// The browser side of the render gate fuzz: the two renderers under client React,
// which writes through the DOM where the server writes markup. A custom element
// gets properties here and the namespace of a tag comes from createElementNS, so
// this is not the same test as the published markup.
//
//   island  renderComponentNode, as CommerceIsland mounts a page's descendants.
//   canvas  HeadlessComponentRenderer on the real model, through
//           createComponentElement, the dispatch the editor canvas shares.
//
// Each probe has its own root, so one that throws costs only itself.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import ComponentModel, { ComponentTypeEnum, type ComponentInstance } from '@/models/ComponentModel';
import HeadlessComponentRenderer from '@/lib/renderer/HeadlessComponentRenderer';
import { renderComponentNode } from '@/lib/renderer/server/renderComponentNode';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';

interface WireProbe {
  id: string;
  node: Record<string, unknown>;
}

interface GateWindow {
  __mount: (surface: 'island' | 'canvas', probes: WireProbe[]) => void;
  __crash: (id: string, message: string) => void;
}

const gate = window as unknown as GateWindow;
const BREAKPOINTS = [{ id: 'desktop', minWidth: 1200, label: 'Desktop' }];

const toSnapshot = (node: Record<string, unknown>): Record<string, unknown> => ({
  id: node.id,
  type: node.type,
  componentType: ComponentTypeEnum.HOST,
  props: node.props,
  children: ((node.children ?? []) as Record<string, unknown>[]).map(toSnapshot),
});

function element(surface: 'island' | 'canvas', node: Record<string, unknown>): React.ReactNode {
  if (surface === 'island') return renderComponentNode(node as unknown as ComponentNode);
  const component = ComponentModel.create(toSnapshot(node) as never) as ComponentInstance;
  return <HeadlessComponentRenderer component={component} breakpointId="desktop" allBreakpoints={BREAKPOINTS} />;
}

gate.__mount = (surface, probes) => {
  const host = document.getElementById('probes');
  if (!host) throw new Error('the probe page has no host');
  for (const { id, node } of probes) {
    const box = document.createElement('div');
    box.dataset.probe = id;
    host.appendChild(box);
    const report = (error: unknown) => gate.__crash(id, error instanceof Error ? error.message : String(error));
    try {
      const root = createRoot(box, { onUncaughtError: report, onCaughtError: report });
      flushSync(() => root.render(element(surface, node)));
    } catch (error) {
      report(error);
    }
  }
};
