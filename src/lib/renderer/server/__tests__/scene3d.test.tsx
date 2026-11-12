// @vitest-environment node
// A 3D scene box (src/lib/scene) renders as its box and children on the server; the stored
// `scene` description never reaches the markup. (The poster and the island are slice S3.)

import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ComponentNode } from '@/lib/renderer/publish/hydrateBindings';
import { renderGateProblem } from '@/lib/siteOps/gate';
import { renderComponentNode } from '../renderComponentNode';

const box = (props: Record<string, unknown> = {}): ComponentNode =>
  ({
    id: 'stage',
    type: 'div',
    props: { 'data-scene': 'three', scene: { version: 1, poster: 'a'.repeat(64), secret: '<script>alert(1)</script>' }, style: { height: '100svh' }, ...props },
    children: [{ id: 'h', type: 'h1', props: { children: 'Fallback heading' } }],
  }) as ComponentNode;

describe('a 3D scene box on the server', () => {
  it('renders the box and its children, with the marker and without the stored scene', () => {
    const html = renderToStaticMarkup(<>{renderComponentNode(box())}</>);
    expect(html).toContain('data-scene="three"');
    expect(html).toContain('<h1>Fallback heading</h1>');
    expect(html).not.toMatch(/ scene=|\[object Object\]|alert\(1\)|poster/);
  });

  it('keeps the stored scene off any element, whatever its value', () => {
    for (const scene of ['text', 5, null, ['x'], { a: 1 }]) {
      const html = renderToStaticMarkup(<>{renderComponentNode(box({ scene }))}</>);
      expect(html).not.toMatch(/ scene=/);
    }
  });

  it('is not reported by the render gate (the scene is a setting, not a dropped prop)', () => {
    expect(renderGateProblem(box() as never)).toBeNull();
  });

  it('leaves an FX scene box alone: the two primitives share no prop and no marker', () => {
    const fx = { id: 'fx', type: 'div', props: { 'data-fx': 'scene', fx: { version: 1 } }, children: [] } as ComponentNode;
    const html = renderToStaticMarkup(<>{renderComponentNode(fx)}</>);
    expect(html).not.toContain('data-scene');
  });
});
