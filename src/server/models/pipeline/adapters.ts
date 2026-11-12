// src/server/models/pipeline/adapters.ts
//
// The real ModelValidator and ModelReencoder (ports.ts), backed by the worker. They are exported
// here and wired NOWHERE: no route, no default dependency list. Until a route is built, reviewed
// and enabled (a gated, separate step), the upload stays fail-closed.

import { DECODED_LIMITS } from '../uploadModel';
import type { DecodedStats, ModelReencoder, ModelValidator } from '../ports';
import { runInWorker, type RunOptions } from './run';

export function khronosValidator(options: RunOptions = {}): ModelValidator {
  return {
    // A timeout or an out-of-memory is thrown as a ModelRefusalError (never returned as a pass): the upload
    // answers it as such (413), not as an invalid file.
    validate: (bytes) => runInWorker<{ ok: true } | { ok: false; message: string }>('validate', bytes, {}, options),
  };
}

export function safeReencoder(options: RunOptions = {}): ModelReencoder {
  return {
    async reencode(bytes) {
      return runInWorker<{ bytes: Uint8Array; input: DecodedStats; output: DecodedStats }>('reencode', bytes, DECODED_LIMITS, options);
    },
  };
}
