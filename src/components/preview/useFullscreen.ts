// Real browser fullscreen for the preview root, with an in-window fallback.
// The browser is the source of truth: `native` only ever follows
// `fullscreenchange` (Esc included), never what we last asked for. When the
// Fullscreen API is missing, blocked (an iframe without `allow`), refused
// (no user gesture) or rejects, `fallback` takes over so the person still
// gets the chrome-free, edge to edge view and a way out. Safari keeps the
// webkit-prefixed API, and iPhone Safari has none, so both are handled here.
'use client';
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

type FullscreenDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitFullscreenEnabled?: boolean;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

const getFullscreenElement = (doc: FullscreenDocument) =>
  doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;

/** Whether a real fullscreen request can even be attempted on this element. */
const canRequest = (doc: FullscreenDocument, el: FullscreenElement) => {
  const enabled = doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled;
  if (enabled === false) return false;
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function';
};

export interface UseFullscreenOptions {
  /** Called when real fullscreen ends, by Esc, the exit control or the browser. */
  onLeave?: () => void;
}

export interface FullscreenState {
  /** The root element really is the browser's fullscreen element. */
  native: boolean;
  /** Real fullscreen was not possible: the in-window view stands in for it. */
  fallback: boolean;
  /** Either of the two: show the page alone, with the floating exit control. */
  immersive: boolean;
  /** Never rejects and never throws; falls back instead. */
  enter: () => Promise<void>;
  exit: () => Promise<void>;
  toggle: () => Promise<void>;
}

export function useFullscreen(
  rootRef: RefObject<HTMLElement | null>,
  { onLeave }: UseFullscreenOptions = {},
): FullscreenState {
  const [native, setNative] = useState(false);
  const [fallback, setFallback] = useState(false);
  const nativeRef = useRef(false);
  const pendingRef = useRef(false);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;

  useEffect(() => {
    const doc = document as FullscreenDocument;
    const sync = () => {
      const root = rootRef.current;
      const isNative = root != null && getFullscreenElement(doc) === root;
      const was = nativeRef.current;
      nativeRef.current = isNative;
      setNative(isNative);
      if (isNative) setFallback(false);
      if (was && !isNative) onLeaveRef.current?.();
    };
    doc.addEventListener('fullscreenchange', sync);
    doc.addEventListener('webkitfullscreenchange', sync);
    return () => {
      doc.removeEventListener('fullscreenchange', sync);
      doc.removeEventListener('webkitfullscreenchange', sync);
    };
  }, [rootRef]);

  const enter = useCallback(async () => {
    const root = rootRef.current as FullscreenElement | null;
    if (!root || nativeRef.current || pendingRef.current) return;
    const doc = document as FullscreenDocument;
    if (!canRequest(doc, root)) {
      setFallback(true);
      return;
    }
    pendingRef.current = true;
    try {
      // Safari's prefixed call returns undefined instead of a promise.
      await Promise.resolve(root.requestFullscreen ? root.requestFullscreen() : root.webkitRequestFullscreen?.());
      // The change event normally lands first; this covers engines that skip it.
      if (getFullscreenElement(doc) === root && !nativeRef.current) {
        nativeRef.current = true;
        setNative(true);
        setFallback(false);
      }
    } catch {
      // Refused (no user gesture, policy) or rejected: stay usable in-window.
      setFallback(true);
    } finally {
      pendingRef.current = false;
    }
  }, [rootRef]);

  const exit = useCallback(async () => {
    setFallback(false);
    const doc = document as FullscreenDocument;
    if (getFullscreenElement(doc) !== rootRef.current) return;
    try {
      await Promise.resolve(doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.());
    } catch {
      // The document already left fullscreen; the change event settles state.
    }
  }, [rootRef]);

  const immersive = native || fallback;
  const toggle = useCallback(() => (immersive ? exit() : enter()), [immersive, enter, exit]);

  return { native, fallback, immersive, enter, exit, toggle };
}
