// src/lib/commerce/shopRuntime.tsx
//
// How a shop part node (src/lib/commerce/parts.ts) renders: the control it sits
// in publishes a runtime through context, and every part asks it whether it shows,
// what its text says and which behaviour it carries. Two runtimes implement it:
// the live one (the published page and the editor's Preview: the island's real
// state and handlers) and the canvas one (a preview state picked in the editor,
// with sample data and no handlers). Both build their answers with the same
// function per control, so the canvas shows exactly what a visitor would see.
//
// The designer's props come first and the runtime's last: a designer can change
// how a part looks and reads, never what it does (its type, name, value,
// disabled state, handlers and ARIA wiring are the runtime's).
'use client';

import React, { createContext, useContext } from 'react';
import { isVoidTag } from '@/lib/drag/voidTags';
import { createRunElement } from '@/lib/renderer/runElements';
import { renderOwnText, runLinksAllowedIn } from '@/lib/renderer/textNode';
import {
  SHOP_KEPT_WRAPPER_ATTR,
  fillShopTokensIn,
  shopPartControl,
  shopPartRoleOf,
  shopPartSpec,
  shopPartTag,
  shopPartText,
  type ShopControlKind,
  type ShopLocale,
} from './parts';

/** What one part does in the control's current state. */
export interface ShopPartRender {
  visible: boolean;
  /** Behaviour and state attributes, applied after the designer's. */
  props?: Record<string, unknown>;
  /** The values of the part's `{token}` placeholders. */
  tokens?: Readonly<Record<string, string>>;
  /** The text of a part whose text is the runtime's (a message from the server). */
  text?: string;
  /** A repeated part: one element per item, each with its tokens and attributes. */
  items?: readonly { key: string; tokens: Readonly<Record<string, string>>; props?: Record<string, unknown> }[];
}

export interface ShopRuntime {
  kind: ShopControlKind;
  locale: ShopLocale;
  surface: 'canvas' | 'live';
  part(role: string): ShopPartRender;
}

/** The runtime of the control a part sits in; null outside any control. */
export const ShopRuntimeContext = createContext<ShopRuntime | null>(null);
ShopRuntimeContext.displayName = 'ShopRuntimeContext';

/** The site language the shop controls speak, set by the page (published) or the editor. */
export const ShopLocaleContext = createContext<ShopLocale>('en');
ShopLocaleContext.displayName = 'ShopLocaleContext';

/**
 * The editor's side of the canvas runtime: which preview state each control
 * shows (by control node id) and the site language. Absent outside the editor.
 */
export interface ShopDesignState {
  stateOf(controlId: string): string | undefined;
}
export const ShopDesignContext = createContext<ShopDesignState | null>(null);
ShopDesignContext.displayName = 'ShopDesignContext';

export interface ShopPartElementProps {
  role: string;
  /** The node's stored tag. */
  tag: string;
  /** The designer's DOM props (style or classes, identity attributes, editor handlers on the canvas). */
  domProps: Record<string, unknown>;
  /** The node's own stored text (a string or formatted text), before tokens are filled. */
  storedText: unknown;
  /** The node's rendered child nodes. */
  content?: React.ReactNode;
  /** Where it renders when no control is around it: the canvas shows a stray part, a page does not. */
  surface: 'editor' | 'preview';
  /** False inside a link or a button, where formatted text leaves its links out. */
  linksAllowed?: boolean;
}

/** A part's text as element children, spread so React needs no keys. Links only where a link is valid (not in a button). */
function textChildren(text: unknown, linksAllowed: boolean): React.ReactNode[] {
  if (text === undefined || text === null) return [];
  const rendered = renderOwnText(text, createRunElement, linksAllowed) as React.ReactNode;
  return Array.isArray(rendered) ? rendered : [rendered];
}

const STRAY_STYLE = { opacity: 0.5, outline: '1px dashed #f59e0b' };

/** Attributes a part never carries onto the page: none of them can send what a visitor typed elsewhere. */
const SENDING_ATTRIBUTES = ['action', 'formAction', 'formaction', 'method', 'formMethod', 'formmethod', 'target', 'formTarget', 'formtarget', 'enctype', 'formEncType', 'formenctype'];
/** Attributes a part kept in sight never carries. */
const HIDING_ATTRIBUTES = ['hidden', 'aria-hidden', 'popover', 'inert'];

/** The smallest text a part kept in sight is drawn at, in pixels. */
const MIN_KEPT_FONT_PX = 11;

/** The colour a part kept in sight falls back to when its own would not be read. */
const KEPT_FALLBACK_COLOR = '#111827';


/** Properties pinned to `none` on a part kept in sight and on every wrapper up to its control, always. */
const PINNED_NONE = ['transform', 'scale', 'translate', 'rotate', 'clip-path', 'mask-image', '-webkit-mask-image', 'filter', 'backdrop-filter', 'animation', 'contain'];

/** Whether a computed colour is see-through (transparent, or an alpha under 0.5). */
function seeThrough(color: string): boolean {
  if (!color || color === 'transparent') return true;
  const match = /rgba?\(([^)]*)\)/.exec(color);
  if (!match) return false;
  const parts = match[1].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 4) return false;
  const alpha = parts[3].endsWith('%') ? Number(parts[3].slice(0, -1)) / 100 : Number(parts[3]);
  return Number.isFinite(alpha) && alpha < 0.5;
}

/**
 * Pins a part kept in sight (the demo notice, the simulated payment line, the
 * total, the pay button's wording) readable as it renders, whatever a stylesheet,
 * a rule on any node of the page, an animation or an inherited value says. The
 * values are set inline with `!important`, which outweighs every rule and every
 * animation, now and later (a hover rule that only applies while the visitor
 * points at the button), so they are set always, not only when something hides
 * at render time:
 * - on the part and on every wrapper up to the control: no transform, scale,
 *   translation, rotation, clip, mask, filter, animation or containment, overflow
 *   visible, in the flow (static, so no offset moves it), visible and opaque, and
 *   shown (its display as computed, or block);
 *   each wrapper also gets a marker the guard rule uses to blank its `::before`
 *   and `::after` (src/lib/commerce/parts.ts, shopGuardCss);
 * - on the part: its colour as computed (or a dark default when that is
 *   see-through), the text filled with that colour, no indent, letter and word
 *   spacing not below normal, no outline, and a font
 *   size of at least 11 pixels.
 */
function keepInSight(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView;
  if (!view) return;
  const force = (target: HTMLElement, property: string, value: string) => target.style.setProperty(property, value, 'important');
  // Read everything first: pinning one node changes what its children compute.
  const chain: { node: HTMLElement; display: string }[] = [];
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node !== element && node.hasAttribute('data-component-kind')) break;
    chain.push({ node, display: view.getComputedStyle(node).display });
  }
  const own = view.getComputedStyle(element);
  const color = seeThrough(own.color) ? KEPT_FALLBACK_COLOR : own.color;
  const size = Number.parseFloat(own.fontSize);
  const letterSpacing = Number.parseFloat(own.letterSpacing);
  const wordSpacing = Number.parseFloat(own.wordSpacing);

  for (const { node, display } of chain) {
    force(node, 'display', display && display !== 'none' ? display : 'block');
    force(node, 'visibility', 'visible');
    force(node, 'opacity', '1');
    force(node, 'content-visibility', 'visible');
    force(node, 'overflow', 'visible');
    // In the flow where the design put it: no offset moves it off screen or under something else.
    force(node, 'position', 'static');
    for (const property of PINNED_NONE) force(node, property, 'none');
    if (node !== element && !node.hasAttribute(SHOP_KEPT_WRAPPER_ATTR)) node.setAttribute(SHOP_KEPT_WRAPPER_ATTR, '');
    if (node.hidden) node.hidden = false;
  }
  force(element, 'color', color);
  force(element, '-webkit-text-fill-color', 'currentcolor');
  force(element, 'text-indent', '0');
  force(element, 'outline', 'none');
  if (!Number.isFinite(letterSpacing) || letterSpacing < 0) force(element, 'letter-spacing', 'normal');
  if (!Number.isFinite(wordSpacing) || wordSpacing < 0) force(element, 'word-spacing', 'normal');
  if (!Number.isFinite(size) || size < MIN_KEPT_FONT_PX) force(element, 'font-size', `${MIN_KEPT_FONT_PX}px`);
}

/** A ref that keeps the element in sight after every render, chained to the ref the surface passed, if any. */
function useKeptInSight(enabled: boolean, outer: unknown): React.RefCallback<HTMLElement> | undefined {
  const element = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    if (enabled && element.current) keepInSight(element.current);
  });
  const ref = React.useCallback(
    (node: HTMLElement | null) => {
      element.current = node;
      if (typeof outer === 'function') (outer as (node: HTMLElement | null) => void)(node);
      else if (outer && typeof outer === 'object' && 'current' in outer) (outer as { current: HTMLElement | null }).current = node;
    },
    [outer],
  );
  return enabled ? ref : undefined;
}

/**
 * The rendered children that are shop parts, and nothing else. Each surface keys a
 * child's element by its node id, and a part's id ends with its role
 * (src/lib/commerce/parts.ts), so the check reads the element itself: a
 * ShopPartElement, or a wrapper keyed by a node whose props name a role. A part
 * inside anything else is lifted out of it, and the rest (the wrapper, its text)
 * is left out, and so is a part that is not one of the button's own (its spec's
 * children), so no extra words join a fixed wording.
 */
function onlyPartElements(content: React.ReactNode, own: ReadonlySet<string>): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const collect = (child: React.ReactNode) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as { role?: unknown; component?: { props?: unknown }; children?: React.ReactNode };
    const role = child.type === ShopPartElement ? props.role : props.component ? shopPartRoleOf(props.component.props) : undefined;
    if (typeof role === 'string') {
      // A part of somewhere else (a label moved in) is left out with its text.
      if (own.has(role)) parts.push(child);
      return;
    }
    React.Children.toArray(props.children).forEach(collect);
  };
  React.Children.toArray(content).forEach(collect);
  return parts;
}

/** One shop part, drawn as its control's runtime says. */
export function ShopPartElement({ role, tag, domProps, storedText, content, surface, linksAllowed = true }: ShopPartElementProps): React.ReactElement | null {
  const runtime = useContext(ShopRuntimeContext);
  const locale = useContext(ShopLocaleContext);
  const spec = shopPartSpec(role);
  const keep = !!spec?.keepVisible;
  const keptRef = useKeptInSight(keep, domProps.ref);
  const elementTag = shopPartTag(role, tag);

  // The designer's props, without anything that could send or (for a part kept in sight) hide.
  const ownProps: Record<string, unknown> = { ...domProps };
  for (const key of SENDING_ATTRIBUTES) delete ownProps[key];
  // An input part has no name: its value lives in the island's state, so a form the
  // page wraps around the control has nothing of the visitor's to post.
  if (elementTag === 'input' || elementTag === 'select' || elementTag === 'textarea') delete ownProps.name;
  if (keep) {
    for (const key of HIDING_ATTRIBUTES) delete ownProps[key];
    ownProps.ref = keptRef;
  }

  if (!runtime || runtime.kind !== shopPartControl(role)) {
    // Outside its control it has nothing to do. The canvas still shows it, marked,
    // so the designer can move it back; a page leaves it out (the control draws its
    // own copy of a required part).
    if (surface !== 'editor') return null;
    const style = { ...((ownProps.style as Record<string, unknown> | undefined) ?? {}), ...STRAY_STYLE };
    return React.createElement(
      elementTag,
      { ...ownProps, style, title: 'This shop part works only inside its shop control.' },
      ...(isVoidTag(elementTag) ? [] : [...textChildren(shopPartText(role, storedText, locale), linksAllowed && runLinksAllowedIn(elementTag)), content]),
    );
  }

  const render = runtime.part(role);
  if (!render.visible) return null;
  // A button whose wording is fixed draws only its own parts, whatever it was handed.
  if (spec?.onlyParts) content = onlyPartElements(content, new Set((spec.children ?? []).map((child) => child.role)));
  const editing = ownProps.contentEditable === 'true';
  // While the designer types, the box holds the stored text as typed, tokens and all.
  const raw = spec?.dynamicText ? render.text : editing ? storedText : shopPartText(role, storedText, runtime.locale);

  const draw = (key: React.Key | undefined, tokens: Readonly<Record<string, string>> | undefined, extra?: Record<string, unknown>) => {
    const props: Record<string, unknown> = { ...ownProps, ...(render.props ?? {}), ...(extra ?? {}) };
    if (key !== undefined) props.key = key;
    if (isVoidTag(elementTag)) {
      delete props.children;
      return React.createElement(elementTag, props);
    }
    const text = editing ? raw : fillShopTokensIn(raw, tokens ?? {});
    return React.createElement(elementTag, props, ...textChildren(text, linksAllowed && runLinksAllowedIn(elementTag)), content);
  };

  if (render.items) {
    if (render.items.length === 0) return null;
    // A repeated part's copies are siblings. Each keeps the node's style hook (its
    // states and rules reach every copy on the canvas), only the first its
    // selection identity, so a click on any copy selects the one node.
    return (
      <>
        {render.items.map((item, index) =>
          draw(item.key, { ...(render.tokens ?? {}), ...item.tokens }, index === 0 ? item.props : { ...item.props, 'data-inner-component-id': undefined }),
        )}
      </>
    );
  }
  return draw(undefined, render.tokens);
}
