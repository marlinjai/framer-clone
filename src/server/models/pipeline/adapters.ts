// src/server/models/pipeline/adapters.ts
//
// The real ModelValidator and ModelReencoder (ports.ts), backed by the worker. They are exported
// here and wired NOWHERE: no route, no default dependency list. Until a route is built, reviewed
// and enabled (a gated, separate step), the upload stays fail-closed.

import { DECODED_LIMITS } from '../uploadModel';
import { ModelRefusalError, type DecodedStats, type ModelReencoder, type ModelValidator } from '../ports';
import { runInWorker, type RunOptions } from './run';

export function khronosValidator(options: RunOptions = {}): ModelValidator {
  return {
    async validate(bytes) {
      try { return await runInWorker<{ ok: true } | { ok: false; message: string }>('validate', bytes, {}, options); }
      catch (err) {
        // A validator that timed out or ran out of memory has not approved the file: that is a refusal, not a pass.
        if (err instanceof ModelRefusalError) return { ok: false, message: err.message };
        throw err;
      }
    },
  };
}

export function safeReencoder(options: RunOptions = {}): ModelReencoder {
  return {
    async reencode(bytes) {
      return runInWorker<{ bytes: Uint8Array; input: DecodedStats; output: DecodedStats }>('reencode', bytes, DECODED_LIMITS, options);
    },
  };
}
