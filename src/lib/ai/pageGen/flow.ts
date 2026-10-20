// src/lib/ai/pageGen/flow.ts
//
// State machine of the Generate page dialog, kept pure so all four
// stateful-flow paths are unit-testable
// (knowledge-base/standards/stateful-flow-testing.md):
//
//   editing --start--> running --applied--> applied --undo--> applied(undone)
//      ^                  |                     |
//      +----failed/cancel-+       edit(inputs) -+  (new inputs drop the result)
//
// Keying: every run carries a `requestKey` built from the inputs AND the
// captured target (page + component). A late event for another key (a
// cancelled run answering after all, a run from before a re-open) is ignored,
// and changing any input after a result drops that result from the dialog
// (keeping the same input keeps it). The applied change itself stays in the
// editor: Cmd+Z and the history panel still reach it.

import type { PageGenErrorPayload, PageGenModel, PageGenProgress } from './protocol';
import type { GenerationUndoRecord } from './apply';
import type { TargetKind } from './editorBridge';

export interface FlowInputs {
  brief: string;
  targetKind: TargetKind;
  model: PageGenModel;
  pageTitle: string;
}

export interface FlowError {
  code: string;
  message: string;
  details?: string[];
}

export type FlowState =
  | { phase: 'editing'; inputs: FlowInputs; error?: FlowError }
  | { phase: 'running'; inputs: FlowInputs; requestKey: string; progress: PageGenProgress }
  | {
      phase: 'applied';
      inputs: FlowInputs;
      requestKey: string;
      record: GenerationUndoRecord;
      nodeCount: number;
      warnings: string[];
      undone: boolean;
      undoError?: string;
    };

export type FlowAction =
  | { type: 'edit'; inputs: Partial<FlowInputs>; targetKey: string }
  | { type: 'start'; requestKey: string }
  | { type: 'progress'; requestKey: string; progress: PageGenProgress }
  | { type: 'applied'; requestKey: string; record: GenerationUndoRecord; nodeCount: number; warnings: string[] }
  | { type: 'failed'; requestKey: string; error: FlowError }
  | { type: 'cancel' }
  | { type: 'undone' }
  | { type: 'undoFailed'; reason: string }
  | { type: 'reset'; inputs: FlowInputs };

export const EMPTY_INPUTS: FlowInputs = { brief: '', targetKind: 'newPage', model: 'SONNET', pageTitle: '' };

/** The key a run is bound to: the inputs plus where the result goes. */
export function makeRequestKey(inputs: FlowInputs, targetKey: string): string {
  return JSON.stringify([inputs.brief.trim(), inputs.targetKind, inputs.model, inputs.pageTitle.trim(), targetKey]);
}

export function initialFlow(inputs: FlowInputs = EMPTY_INPUTS): FlowState {
  return { phase: 'editing', inputs };
}

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'edit': {
      if (state.phase === 'running') return state; // inputs are locked while running
      const inputs = { ...state.inputs, ...action.inputs };
      if (state.phase === 'applied') {
        // Same inputs and target: keep the result (no gratuitous re-spend).
        if (makeRequestKey(inputs, action.targetKey) === state.requestKey) return { ...state, inputs };
        return { phase: 'editing', inputs };
      }
      return { phase: 'editing', inputs }; // any edit clears a stale error
    }
    case 'start':
      if (state.phase === 'running') return state;
      return {
        phase: 'running',
        inputs: state.inputs,
        requestKey: action.requestKey,
        progress: { phase: 'generating', receivedChars: 0, attempt: 1 },
      };
    case 'progress':
      if (state.phase !== 'running' || state.requestKey !== action.requestKey) return state;
      return { ...state, progress: action.progress };
    case 'applied':
      if (state.phase !== 'running' || state.requestKey !== action.requestKey) return state;
      return {
        phase: 'applied',
        inputs: state.inputs,
        requestKey: action.requestKey,
        record: action.record,
        nodeCount: action.nodeCount,
        warnings: action.warnings,
        undone: false,
      };
    case 'failed':
      if (state.phase !== 'running' || state.requestKey !== action.requestKey) return state;
      return { phase: 'editing', inputs: state.inputs, error: action.error };
    case 'cancel':
      if (state.phase !== 'running') return state;
      return { phase: 'editing', inputs: state.inputs };
    case 'undone':
      if (state.phase !== 'applied') return state;
      return { ...state, undone: true, undoError: undefined };
    case 'undoFailed':
      if (state.phase !== 'applied') return state;
      return { ...state, undoError: action.reason };
    case 'reset':
      return { phase: 'editing', inputs: action.inputs };
    default:
      return state;
  }
}

/** A message the user can act on, per error code. */
export function describeError(error: PageGenErrorPayload): FlowError {
  const byCode: Record<string, string> = {
    rate_limited: error.message,
    overloaded: 'The AI provider is overloaded right now. Try again in a minute.',
    provider_unavailable: 'The AI provider is unavailable right now. Try again shortly.',
    provider_auth: 'AI generation is misconfigured on the server. Ask an administrator.',
    missing_anthropic_key: 'AI generation is not configured on this server. Ask an administrator.',
    invalid_output: 'The AI produced something the editor cannot use, so nothing was changed. Try again or simplify the brief.',
    refused: 'The AI declined this brief. Rephrase it and try again.',
    unauthorized: 'Your session expired. Sign in again.',
    forbidden: 'You are not allowed to edit this site.',
    sites_not_enabled: error.message,
    no_active_company: error.message,
    auth_unavailable: 'The sign-in service is unavailable. Try again shortly.',
    authz_unavailable: 'The permission service is unavailable. Try again shortly.',
    network_error: error.message,
  };
  return {
    code: String(error.code),
    message: byCode[String(error.code)] ?? error.message,
    ...(error.details && error.details.length > 0 ? { details: error.details } : {}),
  };
}

// ---------- draft persistence (resume) ----------

const DRAFT_PREFIX = 'framer-clone:page-gen-draft:';

/**
 * Persist the unfinished inputs per project, so closing the dialog or
 * reloading keeps the brief. Only inputs are stored (never a run id or a
 * result: nothing derived from a run can be reattached after a reload).
 * Storage may throw (private mode, sandboxed frames): it is a convenience.
 */
export function saveDraft(projectId: string, inputs: FlowInputs): void {
  try {
    window.localStorage.setItem(DRAFT_PREFIX + projectId, JSON.stringify({ v: 1, projectId, inputs }));
  } catch {
    // storage unavailable: drafts are a nicety
  }
}

export function loadDraft(projectId: string): FlowInputs {
  try {
    const raw = window.localStorage.getItem(DRAFT_PREFIX + projectId);
    if (!raw) return EMPTY_INPUTS;
    const parsed = JSON.parse(raw) as { v?: number; projectId?: string; inputs?: Partial<FlowInputs> };
    // A draft must carry its project key; legacy or foreign entries are discarded.
    if (parsed.v !== 1 || parsed.projectId !== projectId || !parsed.inputs) return EMPTY_INPUTS;
    const i = parsed.inputs;
    return {
      brief: typeof i.brief === 'string' ? i.brief : '',
      targetKind: i.targetKind === 'replace' || i.targetKind === 'insert' ? i.targetKind : 'newPage',
      model: i.model === 'HAIKU' ? 'HAIKU' : 'SONNET',
      pageTitle: typeof i.pageTitle === 'string' ? i.pageTitle : '',
    };
  } catch {
    return EMPTY_INPUTS;
  }
}

export function clearDraft(projectId: string): void {
  try {
    window.localStorage.removeItem(DRAFT_PREFIX + projectId);
  } catch {
    // ignore
  }
}
