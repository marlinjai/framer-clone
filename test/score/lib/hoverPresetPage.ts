// One page holding every hover preset case the migration must leave alone. A stored
// tree, so it goes through the whole published path. It is also what produced
// test/score/data/hover-presets-before.html, the output of this tree before presets
// moved to shared classes (commit fdc8289).

import { renderThroughPublishedPage, type PublishedOutput } from './published';

const SVG_BACKGROUND = `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='8' height='8'/>")`;

const box = (id: string, style: Record<string, unknown>, hover: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'div',
  props: { 'data-t': id, style: { width: '120px', height: '40px', ...style }, effects: { hover }, ...extra },
});

/** The kind each probe holds, by its `data-t`. */
export const HOVER_PROBES: Readonly<Record<string, string>> = {
  lift: 'lift',
  dim: 'dim',
  underline: 'underline',
  'second-dim': 'dim',
  'with-class': 'dim',
  'inline-opacity': 'dim',
  'class-opacity': 'dim',
  'class-transition': 'lift',
  'class-translate': 'lift',
  sentinel: 'lift',
};

export const HOVER_TREE = {
  id: 'root',
  type: 'main',
  props: { style: { display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px' } },
  children: [
    box('lift', {}, 'lift'),
    box('dim', {}, 'dim'),
    box('underline', {}, 'underline', { children: 'Underlined' }),
    box('second-dim', {}, 'dim'),
    box('with-class', {}, 'dim', { className: 'card' }),
    // Inline beats the preset today, so `dim` does nothing here, and that stays.
    box('inline-opacity', { opacity: 0.5 }, 'dim'),
    // A responsive node sits in the sheet: the preset ties it and comes later.
    box('class-opacity', { opacity: { base: 0.5, tablet: 0.6 } }, 'dim'),
    box('class-transition', { transition: { base: 'color 1s linear', tablet: 'color 2s linear' } }, 'lift'),
    box('class-translate', { translate: { base: '4px 4px', tablet: '5px 5px' } }, 'lift'),
    // Every value of the sentinel beats the preset, and the first is one the sheet refuses.
    box('sentinel', { backgroundImage: SVG_BACKGROUND, transition: 'color 1s linear', translate: '3px 4px' }, 'lift'),
    box('none', {}, 'none'),
  ],
};

export const renderHoverPage = (): Promise<PublishedOutput> => renderThroughPublishedPage({ tree: HOVER_TREE, definitions: {} });
