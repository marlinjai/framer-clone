// The page script of fxScoped.spec.ts: mounts a stored scene with the engine from source.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LumitraScene } from '@/lib/fx';
import { parseFxScene } from '@/lib/fx/format';

type Page = { __mount: (scene: unknown) => string[]; __update: (scene: unknown) => string[] };

let root: ReturnType<typeof createRoot> | null = null;
const show = (stored: unknown): string[] => {
  const read = parseFxScene(stored);
  if (!read.ok) throw new Error(read.message);
  root ??= createRoot(document.getElementById('stage')!);
  root.render(createElement(LumitraScene, { config: read.scene }));
  return read.notes;
};

// `__update` shows another scene in the SAME mounted scene (an edit in the editor), `__mount` the first one.
(window as unknown as Page).__mount = show;
(window as unknown as Page).__update = show;
