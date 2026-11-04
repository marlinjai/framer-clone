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
// disabled state, keyboard reach, handlers and ARIA wiring are the runtime's;
// on a button or an input the designer's copies of these never reach the page,
// SHOP_RUNTIME_OWNED_PROPS).
'use client';

import React, { createContext, useContext } from 'react';
import { isVoidTag } from '@/lib/drag/voidTags';
import { createRunElement } from '@/lib/renderer/runElements';
import { renderOwnText, runLinksAllowedIn } from '@/lib/renderer/textNode';
import {
  SHOP_KEPT_WRAPPER_ATTR,
  SHOP_RUNTIME_OWNED_PROPS,
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

/**
 * True inside the second or a later copy of a repeated part (a cart line): every
 * node drawn there keeps its style hook but not its selection identity, which only
 * the first copy carries, so an id never repeats on the canvas or in the Preview.
 */
export const ShopRepeatCopyContext = createContext(false);
ShopRepeatCopyContext.displayName = 'ShopRepeatCopyContext';

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
const SENDING_ATTRIBUTES = ['form', 'action', 'formAction', 'formaction', 'method', 'formMethod', 'formmethod', 'target', 'formTarget', 'formtarget', 'enctype', 'formEncType', 'formenctype'];
/** Attributes a part kept in sight never carries. */
const HIDING_ATTRIBUTES = ['hidden', 'aria-hidden', 'popover', 'inert'];
/** Attributes that would give a fixed wording another accessible name or tooltip. */
const RENAMING_ATTRIBUTES = ['aria-label', 'aria-labelledby', 'aria-description', 'title'];

/** The smallest text a part kept in sight is drawn at, in pixels. */
const MIN_KEPT_FONT_PX = 11;

/** The colour a part kept in sight falls back to when its own would not be read. */
const KEPT_FALLBACK_COLOR = '#111827';


/** Properties pinned to `none` on a part kept in sight itself, always (it is a run of text, so none is designed). */
const PART_NONE = ['transform', 'scale', 'translate', 'rotate', 'clip-path', 'mask-image', '-webkit-mask-image', 'filter', 'animation'];

/** The tags of a part kept in sight that a visitor presses or types into (a cart line's remove button). */
const INTERACTIVE_TAG = /^(BUTTON|INPUT|SELECT|TEXTAREA|A)$/;

/** Properties a wrapper keeps unless they hide what it holds: then they are pinned to `none`. */
const WRAPPER_NONE_WHEN_SET = ['clip-path', 'mask-image', '-webkit-mask-image'];

/** One pinned property: the design's own inline value under it, and the kept parts holding it. */
interface Pin {
  value: string;
  priority: string;
  owners: Set<HTMLElement>;
}

/** What the kept parts pinned on each element, so each part's next render starts from the design. */
const PINNED = new WeakMap<HTMLElement, Map<string, Pin>>();
/** The elements each kept part pinned something on. */
const PINNED_BY = new WeakMap<HTMLElement, Set<HTMLElement>>();

/**
 * Takes off what a kept part pinned, putting the design's own inline value back
 * (unless React wrote a new one since, which then stands). A pin another kept part
 * still holds on a shared wrapper stays. Runs before each render's pins and when
 * the part unmounts (the pay label while a payment is processing).
 */
function releaseKept(owner: HTMLElement): void {
  for (const target of PINNED_BY.get(owner) ?? []) {
    const pins = PINNED.get(target);
    if (!pins) continue;
    for (const [property, pin] of pins) {
      if (!pin.owners.delete(owner) || pin.owners.size > 0) continue;
      pins.delete(property);
      // React wrote the design's new value over the pin since (it sets no priority): that value stands.
      if (target.style.getPropertyPriority(property) !== 'important') continue;
      if (pin.value) target.style.setProperty(property, pin.value, pin.priority);
      else target.style.removeProperty(property);
    }
  }
  PINNED_BY.delete(owner);
}

/** Whether a computed colour is see-through (transparent, or an alpha under 0.5). */
function seeThrough(color: string): boolean {
  if (!color || color === 'transparent') return true;
  // rgb(r, g, b, a), rgb(r g b / a), and the forms a browser serializes the rest in: color(srgb r g b / a), oklch(l c h / a), lab(...).
  const match = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(([^)]*)\)$/.exec(color.trim());
  if (!match) return false;
  const slash = match[1].split('/');
  const raw = slash.length > 1 ? slash[1].trim() : /^rgba?\(|^hsla?\(/.test(color.trim()) ? match[1].split(/[\s,]+/).filter(Boolean)[3] : undefined;
  if (raw === undefined) return false;
  const alpha = raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  return Number.isFinite(alpha) && alpha < 0.5;
}

/**
 * Keeps a part kept in sight (the demo notice, the simulated payment line, the
 * total, the pay button's wording) readable as it renders, against accidents: a
 * stylesheet, an inherited value or a wrapper that would hide it. The guarantee
 * covers what a designer or an agent does by mistake (section 5 of
 * docs/plans/2026-11-02-designable-shop-controls.md); the stored design is already
 * held to an allowlist by the normaliser, so the island pins only what would hide,
 * inline with `!important`, and leaves the design's own changes alone (a hover
 * that inverts the pay button's colours, a display that changes at a breakpoint).
 * - On the part itself, always: visible and opaque, the text filled with its
 *   colour, no transform, clip, mask, filter or animation, no indent or outline,
 *   letter and word spacing not below normal, and a font size of at least 11
 *   pixels, and lifted above its siblings (position relative, z-index 1). Its
 *   colour only when the computed one is see-through (then a dark default), so it
 *   still follows its button's colour on hover.
 * - On the part and every wrapper up to the control, only where it would hide: a
 *   display of none (then block), a visibility other than visible, an opacity
 *   under 0.5 (or any fade, when the wrappers' opacities multiply under 0.5), `content-visibility: hidden`, paint, size or strict containment, a
 *   clip path or mask, and an overflow that crops what it holds. Each wrapper
 *   also gets a marker the guard rule uses to blank its `::before` and `::after`
 *   (src/lib/commerce/parts.ts, shopGuardCss).
 * - On a part a visitor presses (a cart line's remove button): `pointer-events:
 *   auto` on the part, and on every wrapper up to the control whose computed value
 *   is `none`, so a press is never let through to the page behind.
 */
function keepInSight(element: HTMLElement): void {
  const view = element.ownerDocument.defaultView;
  if (!view) return;
  const force = (target: HTMLElement, property: string, value: string) => {
    const pins = PINNED.get(target) ?? new Map<string, Pin>();
    let pin = pins.get(property);
    if (!pin) {
      // The design's own inline value, put back when no part holds the pin any more.
      pin = { value: target.style.getPropertyValue(property), priority: target.style.getPropertyPriority(property), owners: new Set() };
      pins.set(property, pin);
    }
    pin.owners.add(element);
    PINNED.set(target, pins);
    const targets = PINNED_BY.get(element) ?? new Set<HTMLElement>();
    targets.add(target);
    PINNED_BY.set(element, targets);
    target.style.setProperty(property, value, 'important');
  };
  // Each render starts from the design: what this part pinned at its last render
  // comes off first (releaseKept), so a fade or a colour the designer changed since
  // shows on the canvas.
  releaseKept(element);
  // Read everything first: pinning one node changes what its children compute.
  const chain: { node: HTMLElement; computed: CSSStyleDeclaration; crops: boolean }[] = [];
  let control: HTMLElement | null = null;
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node !== element && node.hasAttribute('data-component-kind')) {
      control = node;
      break;
    }
    const computed = view.getComputedStyle(node);
    chain.push({ node, computed, crops: node !== element && computed.overflow !== 'visible' && node.scrollHeight > node.clientHeight + 1 });
  }
  const own = view.getComputedStyle(element);
  const ownColor = own.color;
  const size = Number.parseFloat(own.fontSize);
  const letterSpacing = Number.parseFloat(own.letterSpacing);
  const wordSpacing = Number.parseFloat(own.wordSpacing);

  // Opacity multiplies down the tree: three wrappers at 0.6 draw the part at about 0.2,
  // though each is fine on its own. When the product falls under 0.5, every faded
  // wrapper is pinned opaque.
  const opacityOf = (computed: CSSStyleDeclaration) => (computed.opacity === '' ? 1 : Number(computed.opacity));
  const fadedTogether = chain.slice(1).reduce((product, { computed }) => product * opacityOf(computed), 1) < 0.5;
  const interactive = INTERACTIVE_TAG.test(element.tagName);
  for (const { node, computed, crops } of chain) {
    if (computed.display === 'none') force(node, 'display', 'block');
    // A part a visitor presses takes the press: no wrapper lets it fall through.
    if (interactive && computed.getPropertyValue('pointer-events') === 'none') force(node, 'pointer-events', 'auto');
    if (computed.visibility !== 'visible') force(node, 'visibility', 'visible');
    if (opacityOf(computed) < 0.5 || (fadedTogether && opacityOf(computed) < 1)) force(node, 'opacity', '1');
    if (computed.getPropertyValue('content-visibility') === 'hidden') force(node, 'content-visibility', 'visible');
    const contain = computed.getPropertyValue('contain');
    if (contain.split(/\s+/).some((token) => token === 'paint' || token === 'strict' || token === 'content' || token === 'size')) force(node, 'contain', 'none');
    for (const property of WRAPPER_NONE_WHEN_SET) {
      const value = computed.getPropertyValue(property);
      if (value && value !== 'none') force(node, property, 'none');
    }
    if (crops) force(node, 'overflow', 'visible');
    if (node !== element && !node.hasAttribute(SHOP_KEPT_WRAPPER_ATTR)) node.setAttribute(SHOP_KEPT_WRAPPER_ATTR, '');
    if (node.hidden) node.hidden = false;
  }
  force(element, 'visibility', 'visible');
  force(element, 'opacity', '1');
  // Above its siblings: they carry no z-index or positioning (the normaliser strips
  // both beside it), so nothing placed in the same grid cell paints over it.
  force(element, 'position', 'relative');
  force(element, 'z-index', '1');
  // The lift stays inside the control: it never paints over the site's own sticky header.
  if (control && view.getComputedStyle(control).isolation !== 'isolate') force(control, 'isolation', 'isolate');
  for (const property of PART_NONE) force(element, property, 'none');
  if (seeThrough(ownColor)) force(element, 'color', KEPT_FALLBACK_COLOR);
  force(element, '-webkit-text-fill-color', 'currentcolor');
  force(element, 'text-indent', '0');
  // A button kept in sight (a cart line's remove button) keeps its focus ring and takes a press.
  if (interactive) force(element, 'pointer-events', 'auto');
  else force(element, 'outline', 'none');
  if (!Number.isFinite(letterSpacing) || letterSpacing < 0) force(element, 'letter-spacing', 'normal');
  if (!Number.isFinite(wordSpacing) || wordSpacing < 0) force(element, 'word-spacing', 'normal');
  if (!Number.isFinite(size) || size < MIN_KEPT_FONT_PX) force(element, 'font-size', `${MIN_KEPT_FONT_PX}px`);
}

/** keepInSight, for tests of the pins across renders. */
export const keepInSightForTest = keepInSight;

/** A ref that keeps the element in sight after every render, chained to the ref the surface passed, if any. */
function useKeptInSight(enabled: boolean, outer: unknown): React.RefCallback<HTMLElement> | undefined {
  const element = React.useRef<HTMLElement | null>(null);
  React.useLayoutEffect(() => {
    const current = element.current;
    if (!enabled || !current) return undefined;
    keepInSight(current);
    // Before the next render's pins, and when the part leaves the page.
    return () => releaseKept(current);
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
  // Whether it can be pressed, typed into or reached by the keyboard is the runtime's,
  // in any spelling (a stored `tabindex` as well as `tabIndex`).
  for (const key of SHOP_RUNTIME_OWNED_PROPS[elementTag] ?? []) delete ownProps[key];
  // Nothing renames a fixed wording for assistive technology (a label or tooltip of the designer's).
  if (keep || spec?.fixedText || spec?.onlyParts) for (const key of RENAMING_ATTRIBUTES) delete ownProps[key];
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
  // A part kept in sight, or one whose text is the platform's, draws its text only.
  if (spec?.keepVisible || spec?.fixedText) content = undefined;
  // A button whose wording is fixed draws only its own parts, whatever it was handed.
  if (spec?.onlyParts) content = onlyPartElements(content, new Set((spec.children ?? []).map((child) => child.role)));
  // A part with fixed text (or a run time message) is never typed into: a stored contentEditable
  // must not make it draw stored text, which the published page strips.
  const editing = ownProps.contentEditable === 'true' && !spec?.fixedText && !spec?.dynamicText;
  // While the designer types, the box holds the stored text as typed, tokens and all.
  // A button whose wording is fixed holds no text of its own: its parts are the words.
  const raw = spec?.onlyParts ? undefined : spec?.dynamicText || render.text !== undefined ? render.text : editing ? storedText : shopPartText(role, storedText, runtime.locale);

  const draw = (
    key: React.Key | undefined,
    tokens: Readonly<Record<string, string>> | undefined,
    extra?: Record<string, unknown>,
    itemRuntime?: ShopRuntime,
    /** For a copy of a repeated part: whether it is the second or a later one. */
    copy?: boolean,
  ) => {
    const props: Record<string, unknown> = { ...ownProps, ...(render.props ?? {}), ...(extra ?? {}) };
    if (key !== undefined) props.key = key;
    if (isVoidTag(elementTag)) {
      delete props.children;
      return React.createElement(elementTag, props);
    }
    const text = editing ? raw : fillShopTokensIn(raw, tokens ?? {});
    // A repeated part's own parts read their item (a cart line's title reads that line).
    let inner = itemRuntime && content !== undefined ? <ShopRuntimeContext.Provider value={itemRuntime}>{content}</ShopRuntimeContext.Provider> : content;
    // Inside a later copy, nothing carries the selection identity again. Every copy
    // has the provider, so a copy that becomes the first (the line above it removed)
    // keeps its elements and the focus in them.
    if (copy !== undefined && inner !== undefined) inner = <ShopRepeatCopyContext.Provider value={copy}>{inner}</ShopRepeatCopyContext.Provider>;
    return React.createElement(elementTag, props, ...textChildren(text, linksAllowed && runLinksAllowedIn(elementTag)), inner);
  };

  if (render.items) {
    if (render.items.length === 0) return null;
    // A repeated part's copies are siblings. Each keeps the node's style hook (its
    // states and rules reach every copy on the canvas), only the first its
    // selection identity, so a click on any copy selects the one node; the nodes
    // inside a later copy lose theirs too (ShopRepeatCopyContext).
    return (
      <>
        {render.items.map((item, index) =>
          draw(
            item.key,
            { ...(render.tokens ?? {}), ...item.tokens },
            index === 0 ? item.props : { ...item.props, 'data-inner-component-id': undefined },
            item.runtime,
            index > 0,
          ),
        )}
      </>
    );
  }
  return draw(undefined, render.tokens);
}
