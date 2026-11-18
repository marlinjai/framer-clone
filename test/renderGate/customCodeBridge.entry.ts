// The page side of the custom code bridge gate (customCodeBridge.gate.ts): the real
// behaviour runtime, the real broker and the real registry, bundled by the gate with
// esbuild. The page calls `__start` with a program and the blocks as the server would
// accept them; each block's box shows its fallback until the broker settles it, as the
// island does. What the frames send back for the test (`{ probe }`) is collected; the
// broker ignores such window messages, as it ignores everything that is not a hello.

import { startBehaviour } from '@/lib/behaviour/runtime';
import { createVerbs, isOpen, isTextEntry, keysAnswer, pointerAt, selectionAt, viewObserver } from '@/lib/behaviour/verbs';
import type { BehaviourProgram } from '@/lib/behaviour/program';
import { createBroker } from '@/lib/customCode/broker';
import { addBlock, type IslandBlock } from '@/lib/customCode/registry';

interface GateWindow {
  __settled: { id: string; shown: boolean }[];
  __probes: Record<string, unknown>[];
  __start(program: BehaviourProgram, blocks: { id: string; block: IslandBlock }[]): void;
}

const w = window as unknown as GateWindow;
w.__settled = [];
w.__probes = [];
addEventListener('message', (event) => {
  if (event.data && typeof event.data === 'object' && 'probe' in event.data) w.__probes.push(event.data);
});

w.__start = (program, blocks) => {
  for (const { id, block } of blocks) {
    const el = document.getElementById(id) as HTMLElement;
    let failed = false;
    addBlock({
      el,
      block,
      settle: (shown) => {
        w.__settled.push({ id, shown });
        if (failed) return;
        if (!shown) failed = true;
        const fallback = el.querySelector('[data-fallback]') as HTMLElement | null;
        if (fallback) fallback.hidden = shown;
      },
    });
  }
  startBehaviour({
    container: document,
    program,
    surface: 'published',
    verbs: createVerbs,
    extras: { keysAnswer, isTextEntry, pointerAt, isOpen, viewObserver, selectionAt },
    broker: createBroker,
  });
};
