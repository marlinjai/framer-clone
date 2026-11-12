// src/lib/fxScene/start.ts
//
// When an FX scene may start, and whether it starts at all: the part of the
// published island's logic (src/lib/renderer/server/FxIsland.tsx) that the editor's
// preview shares (src/components/fx/FxLayer.tsx), so "the preview behaves as the
// published page" is one implementation and not two that agree by luck.
//
// It carries no engine code and imports nothing: it is part of the client code of
// every published page that has a scene, before the engine is fetched.

/** The shape of one scene's settings this file reads (the rest is the mount's). */
export interface FxStartSettings {
  start: 'settled' | 'visible' | 'immediate';
  calm: 'background' | 'frame';
}

/** After the page's `load` event: what lumitra.co waits before its hero starts. */
export const FX_SETTLE_DELAY_MS = 1500;

export const FX_WARNING = 'An FX scene could not be drawn here; the page shows its background instead.';

export const FX_REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/** One throwaway context, released at once, so the probe holds no slot of the browser's limit. */
export function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

/**
 * What to do with the one scene that may draw, before anything is fetched:
 *  - `calm`: reduced motion is asked for and the scene's calm state is its background;
 *  - `off`: this browser has no WebGL;
 *  - `go`: wait for the start (whenStarted), then fetch the engine and draw. Under
 *    reduced motion with `calm: frame` the engine holds the scene as one still frame.
 */
export function fxStartDecision(scene: FxStartSettings): 'calm' | 'off' | 'go' {
  if (window.matchMedia(FX_REDUCED_MOTION_QUERY).matches && scene.calm === 'background') return 'calm';
  return hasWebGL() ? 'go' : 'off';
}

/** Calls `go` when the scene may start; returns a cancel. */
export function whenStarted(box: Element, start: FxStartSettings['start'], go: () => void): () => void {
  if (start === 'immediate') {
    go();
    return () => {};
  }
  if (start === 'visible') {
    if (typeof IntersectionObserver === 'undefined') {
      go();
      return () => {};
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        go();
      },
      // One viewport height above and below: the scene is ready as the box scrolls in.
      { rootMargin: '100% 0px' },
    );
    observer.observe(box);
    return () => observer.disconnect();
  }
  let timer: number | undefined;
  const arm = () => {
    timer = window.setTimeout(go, FX_SETTLE_DELAY_MS);
  };
  // `load` may have fired before this ran (a late hydration, or the editor's preview).
  if (document.readyState === 'complete') arm();
  else window.addEventListener('load', arm, { once: true });
  return () => {
    window.removeEventListener('load', arm);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
