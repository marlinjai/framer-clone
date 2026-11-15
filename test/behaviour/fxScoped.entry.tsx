// The page script of fxScoped.spec.ts: mounts a stored scene with the engine from source.
import { StrictMode, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LumitraScene } from '@/lib/fx';
import { parseFxScene } from '@/lib/fx/format';

type Page = { __mount: (scene: unknown) => string[]; __update: (scene: unknown) => string[] };

let root: ReturnType<typeof createRoot> | null = null;
const show = (stored: unknown): string[] => {
  // Test only: the harness has no site image store, so any address is accepted (the reader refuses every address otherwise).
  const read = parseFxScene(stored, { isAllowedImageSrc: () => true });
  if (!read.ok) throw new Error(read.message);
  root ??= createRoot(document.getElementById('stage')!);
  const scene = createElement(LumitraScene, { config: read.scene });
  // The development build with StrictMode, as `next dev` runs pages: effects run twice on mount.
  root.render((window as unknown as { __strict?: boolean }).__strict ? createElement(StrictMode, null, scene) : scene);
  return read.notes;
};

// `__update` shows another scene in the SAME mounted scene (an edit in the editor), `__mount` the first one.
(window as unknown as Page).__mount = show;
(window as unknown as Page).__update = show;
