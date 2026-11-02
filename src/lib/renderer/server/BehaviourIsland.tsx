// BehaviourIsland: the published page's client boundary for stored behaviour. Renders
// nothing. The runtime is a separate chunk, reached by the dynamic import in the effect,
// so it is fetched only where this island is rendered, which is a page with a trigger.
// What the program needs beside it is fetched at the same time, since a second round trip
// after the first comes out of the gate's 3 seconds. A chunk that does not arrive lowers
// the gate at once, rather than at its timeout.
'use client';

import { useEffect } from 'react';
import { GATE_GLOBAL } from '@/lib/behaviour/names';
import type { BehaviourProgram } from '@/lib/behaviour/program';

export default function BehaviourIsland({ program }: { program: BehaviourProgram }) {
  useEffect(() => {
    let stop: (() => void) | undefined;
    let left = false;
    Promise.all([
      import('@/lib/behaviour/runtime'),
      program.verbs ? import('@/lib/behaviour/verbs') : undefined,
    ]).then(
      ([{ startBehaviour }, verbs]) => {
        if (!left) stop = startBehaviour({ container: document, program, surface: 'published', verbs: verbs?.createVerbs, keys: verbs });
      },
      (error: unknown) => {
        console.error('Page behaviour did not load: showing everything.', error);
        (window as unknown as Record<string, { fail(): void } | undefined>)[GATE_GLOBAL]?.fail();
      },
    );
    return () => {
      left = true;
      stop?.();
    };
  }, [program]);

  return null;
}
