// The page script of fxPick.spec.ts: mounts a stored scene with the engine from source, with the
// editor's probe handed over or not, and answers what is under a point through the editor-only pick code.
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { LumitraScene } from '@/lib/fx';
import { parseFxScene } from '@/lib/fx/format';
import { createPicker, type SceneProbe } from '@/lib/fx/pick';

type Page = { __mount: (scene: unknown, withProbe: boolean) => string[]; __pick: (x: number, y: number) => string | null; __probe: () => boolean };

let probe: SceneProbe | null = null;
let root: ReturnType<typeof createRoot> | null = null;

const page = window as unknown as Page;
page.__mount = (stored, withProbe) => {
  const read = parseFxScene(stored);
  if (!read.ok) throw new Error(read.message);
  root ??= createRoot(document.getElementById('stage')!);
  root.render(createElement(LumitraScene, { config: read.scene, ...(withProbe ? { onProbe: (next: SceneProbe | null) => (probe = next) } : {}) }));
  return read.notes;
};
page.__probe = () => probe !== null;
page.__pick = (x, y) => (probe ? createPicker(probe).pickAt(x, y) : null);
