// The box's footing for an FX layer (../box): holds nest in any order, the last undo restores the box.

import { describe, expect, it } from 'vitest';
import { holdFxBox, reholdFxBox } from '../box';

const box = (style = '') => {
  const element = document.createElement('div');
  element.setAttribute('style', style);
  document.body.appendChild(element);
  return element;
};

describe('holdFxBox', () => {
  it('gives a static box a stacking context and a position, and takes both back', () => {
    const b = box();
    const undo = holdFxBox(b);
    expect(b.style.isolation).toBe('isolate');
    expect(b.style.position).toBe('relative');
    undo();
    expect(b.style.isolation).toBe('');
    expect(b.style.position).toBe('');
  });

  it('leaves a positioned box its position', () => {
    const b = box('position: absolute');
    const undo = holdFxBox(b);
    expect(b.style.position).toBe('absolute');
    undo();
    expect(b.style.position).toBe('absolute');
  });

  it('nested holds released first-in-first-out keep the footing until the last one goes', () => {
    const b = box();
    const first = holdFxBox(b);
    const second = holdFxBox(b);
    first();
    expect(b.style.isolation).toBe('isolate');
    expect(b.style.position).toBe('relative');
    // An undo called twice counts once.
    first();
    expect(b.style.position).toBe('relative');
    second();
    expect(b.style.isolation).toBe('');
    expect(b.style.position).toBe('');
  });

  it('rehold takes the footing again on a position the author set meanwhile, for every hold', () => {
    const b = box();
    const a = holdFxBox(b);
    const c = holdFxBox(b);
    b.style.position = 'fixed';
    reholdFxBox(b);
    a();
    c();
    expect(b.style.position).toBe('fixed');
    expect(b.style.isolation).toBe('');
  });

  it('rehold twice in one commit never records the hold own footing as the box position', () => {
    const b = box();
    b.style.position = 'absolute';
    const a = holdFxBox(b);
    const c = holdFxBox(b);
    // The author removes the position: the renderer writes it, and each hold reholds.
    b.style.position = '';
    reholdFxBox(b);
    reholdFxBox(b);
    expect(b.style.position).toBe('relative');
    a();
    c();
    expect(b.style.position).toBe('');
    expect(b.style.isolation).toBe('');
  });

  it('a position the renderer owns at the last undo is left alone', () => {
    const b = box();
    const undo = holdFxBox(b);
    b.style.position = 'sticky';
    undo(true);
    expect(b.style.position).toBe('sticky');
  });
});
