import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PageBaseStyles } from '../PageBaseStyles';
import { RESET_PSEUDO_ELEMENTS, pageBaseSheet, surfacePageBaseSheet } from '../pageBase';

const ROOTS = ['[data-frame]', '[data-other]'];

describe('pageBaseSheet', () => {
  it('writes nothing for the reset, the base every site starts on', () => {
    expect(pageBaseSheet('reset')).toBe('');
  });

  it('rolls back the base layer and not the author origin, which holds what the markup says', () => {
    const css = pageBaseSheet('browser');
    expect(css.startsWith('@layer base{')).toBe(true);
    expect(css).toContain('all:revert-layer');
    expect(css).not.toMatch(/all:revert[;}]/);
  });

  it('holds no character that could close the style element', () => {
    expect(pageBaseSheet('browser')).not.toContain('<');
    expect(surfacePageBaseSheet('browser', ROOTS)).not.toContain('<');
  });

  it('writes each pseudo-element as a rule of its own, so one a browser refuses costs only that rule', () => {
    const css = pageBaseSheet('browser');
    for (const pseudo of RESET_PSEUDO_ELEMENTS) expect(css).toContain(`${pseudo}{all:revert-layer}`);
    expect(css).not.toMatch(/,[^{}]*\{all:revert-layer/);
  });
});

describe('surfacePageBaseSheet', () => {
  it('writes nothing for the reset or without a frame', () => {
    expect(surfacePageBaseSheet('reset', ROOTS)).toBe('');
    expect(surfacePageBaseSheet('browser', [])).toBe('');
  });

  it('reaches only what sits inside a frame, or the editor would lose its own reset', () => {
    const css = surfacePageBaseSheet('browser', ROOTS);
    const rolledBack = [...css.matchAll(/([^{}]+)\{all:revert-layer\}/g)].map((match) => match[1].replace('@layer base{', ''));
    expect(rolledBack.length).toBe((RESET_PSEUDO_ELEMENTS.length + 1) * ROOTS.length);
    for (const selector of rolledBack) expect(selector.startsWith('[data-frame] ') || selector.startsWith('[data-other] ')).toBe(true);
  });

  it('hands down from the frame what the document hands down on a published page', () => {
    const css = surfacePageBaseSheet('browser', ROOTS);
    expect(css).toContain('[data-frame],[data-other]{color:CanvasText;');
    expect(css).toContain('line-height:normal');
  });
});

describe('PageBaseStyles', () => {
  it('renders nothing on the reset, and the sheet on the browser base', () => {
    expect(renderToStaticMarkup(<PageBaseStyles base="reset" roots={ROOTS} />)).toBe('');
    const html = renderToStaticMarkup(<PageBaseStyles base="browser" roots={ROOTS} />);
    expect(html).toContain('data-fc-page-base');
    expect(html).toContain('all:revert-layer');
  });
});
