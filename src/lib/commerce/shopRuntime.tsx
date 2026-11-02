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
import { renderOwnText } from '@/lib/renderer/textNode';
import {
  fillShopTokensIn,
  shopPartControl,
  shopPartSpec,
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

/** The tag a behaviour role always renders as, whatever the node's stored type. */
const FORCED_TAGS: ReadonlyArray<[RegExp, string]> = [
  [/^checkout\.(button|pay|back)$/, 'button'],
  [/^checkout\.(input\.[A-Za-z0-9]+|decline-input)$/, 'input'],
];

export function shopPartTag(role: string, stored: string): string {
  return FORCED_TAGS.find(([pattern]) => pattern.test(role))?.[1] ?? stored;
}

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
}

/** A part's text as element children, spread so React needs no keys. Links stay out: a part may sit in a button. */
function textChildren(text: unknown): React.ReactNode[] {
  if (text === undefined || text === null) return [];
  const rendered = renderOwnText(text, createRunElement, false) as React.ReactNode;
  return Array.isArray(rendered) ? rendered : [rendered];
}

const STRAY_STYLE = { opacity: 0.5, outline: '1px dashed #f59e0b' };

/** One shop part, drawn as its control's runtime says. */
export function ShopPartElement({ role, tag, domProps, storedText, content, surface }: ShopPartElementProps): React.ReactElement | null {
  const runtime = useContext(ShopRuntimeContext);
  const locale = useContext(ShopLocaleContext);

  if (!runtime || runtime.kind !== shopPartControl(role)) {
    // Outside its control it has nothing to do. The canvas still shows it, marked,
    // so the designer can move it back; a page leaves it out (the control draws its
    // own copy of a required part).
    if (surface !== 'editor') return null;
    const style = { ...((domProps.style as Record<string, unknown> | undefined) ?? {}), ...STRAY_STYLE };
    return React.createElement(
      tag,
      { ...domProps, style, title: 'This shop part works only inside its shop control.' },
      ...(isVoidTag(tag) ? [] : [...textChildren(shopPartText(role, storedText, locale)), content]),
    );
  }

  const render = runtime.part(role);
  if (!render.visible) return null;
  const spec = shopPartSpec(role);
  const elementTag = shopPartTag(role, tag);
  const editing = domProps.contentEditable === 'true';
  // While the designer types, the box holds the stored text as typed, tokens and all.
  const raw = spec?.dynamicText ? render.text : editing ? storedText : shopPartText(role, storedText, runtime.locale);

  const draw = (key: React.Key | undefined, tokens: Readonly<Record<string, string>> | undefined, extra?: Record<string, unknown>) => {
    const props: Record<string, unknown> = { ...domProps, ...(render.props ?? {}), ...(extra ?? {}) };
    if (key !== undefined) props.key = key;
    if (isVoidTag(elementTag)) {
      delete props.children;
      return React.createElement(elementTag, props);
    }
    const text = editing ? raw : fillShopTokensIn(raw, tokens ?? {});
    return React.createElement(elementTag, props, ...textChildren(text), content);
  };

  if (render.items) {
    if (render.items.length === 0) return null;
    // A repeated part's copies are siblings; the first keeps the designer's identity.
    return (
      <>
        {render.items.map((item, index) =>
          draw(item.key, { ...(render.tokens ?? {}), ...item.tokens }, index === 0 ? item.props : { ...item.props, 'data-component-id': undefined, 'data-inner-component-id': undefined }),
        )}
      </>
    );
  }
  return draw(undefined, render.tokens);
}
