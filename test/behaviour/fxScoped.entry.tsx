// The page script of fxScoped.spec.ts: mounts a stored scene with the engine from source.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LumitraScene } from '@/lib/fx';
import { parseFxScene } from '@/lib/fx/format';

(window as unknown as { __mount: (scene: unknown) => string[] }).__mount = (stored) => {
  const read = parseFxScene(stored);
  if (!read.ok) throw new Error(read.message);
  createRoot(document.getElementById('stage')!).render(createElement(LumitraScene, { config: read.scene }));
  return read.notes;
};
