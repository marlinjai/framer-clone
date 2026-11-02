// src/lib/behaviour/presets/carousel.ts
//
// A carousel: Previous and Next as buttons, slides that announce themselves when a person
// moves them, and rotation only when asked for. See
// docs/plans/2026-11-02-behaviour-model.md, "Presets".
//
// Rotation runs while `playing` is on and the pointer is elsewhere. Focus entering the
// carousel stops it until a person starts it again, as the Authoring Practices ask. The
// runtime starts no `every` under reduced motion, so the rotation control hides there
// rather than offer what cannot happen. A press on that control keeps the focus where it
// was, because focus arriving would stop what the press is about to switch.
//
// Without a script every slide shows in order and the buttons are hidden.
//
// PURE: no React, no MST.

import { MIN_EVERY_MS, type Action, type Trigger } from '../format';
import { assertSeed, behaviourOf, copyItem, derived, el, initialOf, propsOf, stateIdOn, withProps, type PresetNode } from './nodes';

export const CAROUSEL_VERSION = 1;

export interface CarouselOptions {
  seed: string;
  label?: string;
  slides?: string[];
  /** Rotation, at least 1,000 ms. Left out, the carousel moves only when a person moves it. */
  rotateMs?: number;
}

const BUTTON_STYLE = { padding: '8px 12px', minHeight: '44px', border: '1px solid #e5e5e5', borderRadius: '6px', background: '#fff', font: 'inherit', cursor: 'pointer' };
const SLIDE_STYLE = { minHeight: '160px', padding: '24px', background: '#f5f5f5' };
const CONTROLS_STYLE = { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' };

const isSlide = (node: PresetNode): boolean => propsOf(node)['aria-roledescription'] === 'slide';
const isButton = (node: PresetNode): boolean => node.type === 'button';

/** Writes every generated entry from the slides the root holds. `rotateMs` is read back from the root after the first time. */
export function deriveCarousel(root: PresetNode, firstRotateMs?: number): PresetNode {
  const children = root.children ?? [];
  const slidesNode = children.find((child) => child.children?.some(isSlide));
  // Whatever else a person put in the root, the controls are what holds the buttons.
  const controls = children.find((child) => child !== slidesNode && (child.children ?? []).filter(isButton).length >= 2);
  if (!slidesNode || !controls) return root;
  const slide = stateIdOn(root, 'slide');
  const playing = stateIdOn(root, 'playing');
  const hovered = stateIdOn(root, 'hovered');
  const slides = slidesNode.children ?? [];
  const last = Math.max(0, slides.length - 1);
  const rotateMs = behaviourOf(root).on?.find((trigger) => trigger.on === 'every')?.ms ?? firstRotateMs;
  const rotates = rotateMs !== undefined;
  const stop: Action[] = rotates ? [{ set: playing, value: false }] : [];
  const pressed = (by: 1 | -1): Trigger[] => [{ id: 'press', on: 'click', do: [...stop, { step: slide, by, wrap: true }] }];

  // The controls run rotation, if any, then Previous and Next.
  const [previous, next] = (controls.children ?? []).filter(isButton).slice(-2);
  const control = (node: PresetNode): PresetNode => {
    if (node === previous) return derived(node, { noScript: 'hide', on: pressed(-1) });
    if (node === next) return derived(node, { noScript: 'hide', on: pressed(1) });
    if (!isButton(node) || !rotates) return node;
    return derived(node, {
      noScript: 'hide',
      on: [
        { id: 'keep-focus', on: 'mousedown', prevent: true, do: [{ set: hovered, value: true }] },
        { id: 'press', on: 'click', do: [{ toggle: playing }] },
      ],
      bind: [{ text: { map: playing, cases: { true: 'Stop rotation', false: 'Start rotation' } } }],
    });
  };

  const slideEntry = (node: PresetNode, index: number): PresetNode =>
    derived(withProps(node, { 'aria-label': `${index + 1} of ${slides.length}` }), { showWhen: { state: slide, eq: index } });

  return derived({
    ...root,
    children: children.map((child) => {
      if (child === controls) return { ...controls, children: controls.children?.map(control) };
      if (child !== slidesNode) return child;
      const live = rotates
        ? derived(child, { bind: [{ attr: 'aria-live', from: { map: playing, cases: { true: 'off', false: 'polite' } } }] })
        : withProps(child, { 'aria-live': 'polite' });
      return { ...live, children: slides.map(slideEntry) };
    }),
  }, {
    state: [
      { id: slide, name: 'Current slide', type: 'number', initial: Math.min(initialOf(root, slide), last), min: 0, max: last },
      ...(rotates ? [
        { id: playing, name: 'Rotating', type: 'boolean' as const, initial: true },
        { id: hovered, name: 'Pointer on it', type: 'boolean' as const, initial: false },
      ] : []),
    ],
    on: rotates
      ? [
          { id: 'rotate', on: 'every', ms: rotateMs, if: { all: [{ state: playing, eq: true }, { state: hovered, eq: false }] }, do: [{ step: slide, wrap: true }] },
          { id: 'hover', on: 'mouseenter', do: [{ set: hovered, value: true }] },
          { id: 'leave', on: 'mouseleave', do: [{ set: hovered, value: false }] },
          { id: 'focus', on: 'focusin', do: [{ set: playing, value: false }] },
        ]
      : [],
    preset: { kind: 'carousel', version: CAROUSEL_VERSION },
  });
}

const button = (id: string, text: string, extra: Record<string, unknown> = {}): PresetNode =>
  el(id, 'button', { type: 'button', children: text, style: BUTTON_STYLE, ...extra });

export function carousel({ seed, label = 'Highlights', slides = ['First slide', 'Second slide', 'Third slide'], rotateMs }: CarouselOptions): PresetNode {
  assertSeed(seed);
  // A faster timer is refused when the page is read, which would leave a rotation control that starts nothing.
  if (rotateMs !== undefined && !(Number.isSafeInteger(rotateMs) && rotateMs >= MIN_EVERY_MS)) {
    throw new Error(`a carousel rotates every ${MIN_EVERY_MS} ms or slower, got ${rotateMs}`);
  }
  const rotation = rotateMs === undefined ? [] : [
    button(`${seed}-rotation`, 'Stop rotation', {
      rules: [{ id: 'no-motion', selector: '&', at: ['@media (prefers-reduced-motion: reduce)'], style: { display: 'none' } }],
    }),
  ];
  return deriveCarousel(
    el(seed, 'section', { 'aria-roledescription': 'carousel', 'aria-label': label },
      el(`${seed}-controls`, 'div', { style: CONTROLS_STYLE },
        ...rotation,
        button(`${seed}-previous`, 'Previous slide'),
        button(`${seed}-next`, 'Next slide')),
      el(`${seed}-slides`, 'div', {},
        ...slides.map((text, index) => el(`${seed}-slide-${index}`, 'div', { role: 'group', 'aria-roledescription': 'slide', children: text, style: SLIDE_STYLE })))),
    rotateMs,
  );
}

/** One more slide, cloned from the last, with every generated entry derived again. */
export function addSlide(root: PresetNode, text: string): PresetNode {
  const children = root.children ?? [];
  const slidesNode = children.find((child) => child.children?.some(isSlide));
  const last = slidesNode?.children?.at(-1);
  if (!slidesNode || !last) return root;
  const slide = withProps(copyItem(root, last), { children: text });
  return deriveCarousel({
    ...root,
    children: children.map((child) => (child === slidesNode ? { ...slidesNode, children: [...(slidesNode.children ?? []), slide] } : child)),
  });
}
