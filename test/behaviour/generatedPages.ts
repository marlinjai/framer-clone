// Pages made by the page generator's validator, not written by hand: the model's output as
// the prompt teaches it, through validateGeneration, saved and published like any page.
// So what a visitor gets from a generation is proven on the real route, not only what the
// validator kept. See docs/plans/2026-11-02-behaviour-model.md, "AI output", slice B12.
//
// The validator refuses `data-*`, so the proofs find these nodes by role and text.

import { deriveBreakpointKeys } from '@/lib/ai/pageGen/schema';
import { validateGeneration } from '@/lib/ai/pageGen/validate';
import type { StoredNode } from './pages';

const breakpoints = deriveBreakpointKeys([
  { label: 'Desktop', minWidth: 1280 },
  { label: 'Mobile', minWidth: 320 },
]);

/** What the generator makes of `nodes`, under a page root with a link before and after it. */
function generated(slug: string, nodes: unknown[]): () => StoredNode {
  return () => {
    const outcome = validateGeneration({ nodes }, { breakpoints });
    if (!outcome.ok) throw new Error(`${slug}: the generator refused it: ${outcome.errors.join('; ')}`);
    if (outcome.result.warnings.length > 0) throw new Error(`${slug}: the generator changed it: ${outcome.result.warnings.join('; ')}`);
    const strip = (node: { id: string; type: string; props: Record<string, unknown>; children: unknown[] }): StoredNode => ({
      id: node.id,
      type: node.type,
      componentType: 'host',
      props: node.props,
      children: (node.children as Parameters<typeof strip>[0][]).map(strip),
    });
    return {
      id: `generated-${slug}`,
      type: 'div',
      componentType: 'host',
      props: {},
      children: [
        { id: `${slug}-before`, type: 'a', componentType: 'host', props: { href: '#top', children: 'Before' }, children: [] },
        ...outcome.result.nodes.map(strip),
        { id: `${slug}-after`, type: 'a', componentType: 'host', props: { href: '#end', children: 'After' }, children: [] },
      ],
    };
  };
}

/** The one form the prompt teaches the model to write itself, word for word. */
export const REVEAL = {
  type: 'div',
  props: { behaviour: { state: [{ id: 'open', name: 'Open', type: 'boolean', initial: false }] } },
  children: [
    {
      type: 'button',
      props: {
        type: 'button',
        children: 'Show details',
        behaviour: { on: [{ id: 'press', on: 'click', do: [{ toggle: 'open' }] }], bind: [{ attr: 'aria-expanded', from: { get: 'open' } }] },
      },
    },
    { type: 'p', props: { children: 'The details', behaviour: { showWhen: { state: 'open', eq: true } } } },
  ],
};

export const GENERATED_PAGES: Readonly<Record<string, () => StoredNode>> = {
  'generated-reveal': generated('reveal', [REVEAL]),
  'generated-tabs': generated('tabs', [{
    preset: 'tabs',
    label: 'Sections',
    items: [{ title: 'One', body: 'Panel one' }, { title: 'Two', body: 'Panel two' }, { title: 'Three', body: 'Panel three' }],
    options: { label: 'Sections' },
  }]),
  'generated-menu': generated('menu', [{ preset: 'menu-button', items: ['Copy', 'Paste', 'Delete'], options: { label: 'Actions' } }]),
};
