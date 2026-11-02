// What the worker chunk holds, for the bundle and browser checks: `importSource` on
// the far side of a `postMessage`, as `worker.ts` will have it in slice `import-dialog`.
// It also says whether TypeScript found a system to read, which it must not.

import ts from 'typescript';
import { importAndPost, type ImportOptions, type SourceInput } from '../source';

export interface WorkerRequest {
  files: SourceInput[];
  options?: ImportOptions;
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const started = performance.now();
  void importAndPost(event.data.files, event.data.options ?? {}, (outcome) => {
    self.postMessage({ outcome, hasSystem: ts.sys !== undefined, milliseconds: performance.now() - started });
  });
};
