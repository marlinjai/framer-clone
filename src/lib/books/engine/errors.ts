// src/lib/books/engine/errors.ts
//
// The one error the browser's draft renderer answers (WYSIWYG invoice editor
// plan, phase 1). Every failure is named, so the editor can say what went
// wrong instead of showing a page that differs from the server's: a draft is
// either drawn exactly as the server draws it, or not drawn at all.

export type BrowserRenderErrorCode =
  /** The render input could not be read (GET .../render-input failed or answered something malformed). */
  | 'render_input_failed'
  /** The render input is not a draft the engine can draw (wrong format, not a draft, malformed template). */
  | 'invalid_input'
  /** A font file could not be fetched. */
  | 'font_fetch_failed'
  /** A fetched font file is not the pinned file (its SHA-256 differs). */
  | 'font_hash_mismatch'
  /** A logo the template names and the company has could not be fetched (deleted meanwhile, or the network). */
  | 'logo_fetch_failed'
  /** A fetched logo is not the image its hash names. */
  | 'logo_hash_mismatch'
  /** The engine failed while drawing. */
  | 'render_failed'
  /** This browser cannot run a Web Worker. */
  | 'worker_unsupported'
  /** The worker stopped or could not be started. */
  | 'worker_failed'
  /** The caller aborted the render (a newer keystroke). */
  | 'aborted';

export class BrowserRenderError extends Error {
  readonly code: BrowserRenderErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: BrowserRenderErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BrowserRenderError';
    this.code = code;
    this.details = details;
  }
}

/** A plain object that survives postMessage (an Error's own fields do not). */
export interface SerializedRenderError {
  code: BrowserRenderErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export function serializeRenderError(err: unknown): SerializedRenderError {
  if (err instanceof BrowserRenderError) return { code: err.code, message: err.message, details: err.details };
  return { code: 'render_failed', message: err instanceof Error ? err.message : String(err), details: {} };
}

export function deserializeRenderError(e: SerializedRenderError): BrowserRenderError {
  return new BrowserRenderError(e.code, e.message, e.details);
}
