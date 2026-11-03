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
  /**
   * The text of a part whose text is the runtime's (a message from the server), or
   * the runtime's own words in place of the designer's (an error chip in the editor).
   */
  text?: string;
  /**
   * Kept in sight in this state only, as a part whose spec keeps it in sight always
   * is: the remove button of a cart line that is no longer sold or failed to load,
   * so a visitor is never stuck with that line.
   */
  keepInSight?: true;
  /**
   * A repeated part: one element per item, each with its tokens and attributes, and
   * the runtime its own parts read (a cart line's title, price and quantity).
   */
  items?: readonly {
    key: string;
    tokens: Readonly<Record<string, string>>;
    props?: Record<string, unknown>;
    runtime?: ShopRuntime;
  }[];
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

/**
 * Forces a part kept in sight (the demo notice, the simulated payment line, the
 * total, the pay button's wording) visible as it renders, whatever a stylesheet,
 * a rule on a wrapper or an inherited value says: on the part and on every
 * wrapper up to the control, a computed value that hides is overridden inline
 * with `!important`, which beats any stylesheet. Covered on the part and on the
 * way up: display, visibility, opacity, content visibility, paint containment, a
 * scale, translation, transform, clip path, mask or filter, and a wrapper's overflow
 * that crops; on the part itself a font size under 11 pixels.
 */
function keepInSight(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView;
  if (!view) return;
  const force = (target: HTMLElement, property: string, value: string) => target.style.setProperty(property, value, 'important');
  // The part itself is pinned visible whatever its stylesheet says now or later (a
  // hover rule on an ancestor): inline `!important` outweighs every rule.
  const own = view.getComputedStyle(element);
  force(element, 'display', own.display && own.display !== 'none' ? own.display : 'block');
  force(element, 'visibility', 'visible');
  force(element, 'opacity', '1');
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node !== element && node.hasAttribute('data-component-kind')) break;
    const computed = view.getComputedStyle(node);
    if (computed.display === 'none') force(node, 'display', 'block');
    if (computed.visibility !== 'visible') force(node, 'visibility', 'visible');
    if (computed.opacity !== '' && Number(computed.opacity) < 1) force(node, 'opacity', '1');
    if (computed.getPropertyValue('content-visibility') === 'hidden') force(node, 'content-visibility', 'visible');
    // A wrapper that crops what it holds (a 1px box with overflow hidden, or paint
    // containment) lets it out.
    if (node !== element && computed.overflow !== 'visible' && node.scrollHeight > node.clientHeight + 1) force(node, 'overflow', 'visible');
    const contain = computed.getPropertyValue('contain');
    if (contain.split(/\s+/).some((token) => token === 'paint' || token === 'strict' || token === 'content' || token === 'size')) force(node, 'contain', 'none');
    // A scale, a translation, a transform or a mask on the way up shrinks, moves or
    // masks the part with its wrapper.
    for (const property of ['scale', 'translate', 'transform', 'clip-path', 'mask-image', '-webkit-mask-image', 'filter']) {
      const value = computed.getPropertyValue(property);
      if (value && value !== 'none') force(node, property, 'none');
    }
    if (node.hidden) node.hidden = false;
  }
  const computed = view.getComputedStyle(element);
  const size = Number.parseFloat(computed.fontSize);
  if (Number.isFinite(size) && size < MIN_KEPT_FONT_PX) force(element, 'font-size', `${MIN_KEPT_FONT_PX}px`);
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
 * is left out, so no extra words join a fixed wording.
 */
function onlyPartElements(content: React.ReactNode): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const collect = (child: React.ReactNode) => {
    if (!React.isValidElement(child)) return;
    const props = child.props as { component?: { props?: unknown }; children?: React.ReactNode };
    if (child.type === ShopPartElement || (props.component && shopPartRoleOf(props.component.props))) {
      parts.push(child);
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
  const inControl = !!runtime && runtime.kind === shopPartControl(role);
  const render = inControl ? runtime.part(role) : undefined;
  const keep = !!spec?.keepVisible || (!!render?.visible && !!render.keepInSight);
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

  if (!runtime || !render) {
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

  if (!render.visible) return null;
  // A button whose wording is fixed draws only its own parts, whatever it was handed.
  if (spec?.onlyParts) content = onlyPartElements(content);
  const editing = ownProps.contentEditable === 'true';
  // While the designer types, the box holds the stored text as typed, tokens and all.
  const raw = spec?.dynamicText || render.text !== undefined ? render.text : editing ? storedText : shopPartText(role, storedText, runtime.locale);

  const draw = (
    key: React.Key | undefined,
    tokens: Readonly<Record<string, string>> | undefined,
    extra?: Record<string, unknown>,
    itemRuntime?: ShopRuntime,
  ) => {
    const props: Record<string, unknown> = { ...ownProps, ...(render.props ?? {}), ...(extra ?? {}) };
    if (key !== undefined) props.key = key;
    if (isVoidTag(elementTag)) {
      delete props.children;
      return React.createElement(elementTag, props);
    }
    const text = editing ? raw : fillShopTokensIn(raw, tokens ?? {});
    // A repeated part's own parts read their item (a cart line's title reads that line).
    const inner = itemRuntime && content !== undefined ? <ShopRuntimeContext.Provider value={itemRuntime}>{content}</ShopRuntimeContext.Provider> : content;
    return React.createElement(elementTag, props, ...textChildren(text, linksAllowed && runLinksAllowedIn(elementTag)), inner);
  };

  if (render.items) {
    if (render.items.length === 0) return null;
    // A repeated part's copies are siblings. Each keeps the node's style hook (its
    // states and rules reach every copy on the canvas), only the first its
    // selection identity, so a click on any copy selects the one node.
    return (
      <>
        {render.items.map((item, index) =>
          draw(
            item.key,
            { ...(render.tokens ?? {}), ...item.tokens },
            index === 0 ? item.props : { ...item.props, 'data-inner-component-id': undefined },
            item.runtime,
          ),
        )}
      </>
    );
  }
  return draw(undefined, render.tokens);
}
