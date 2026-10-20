// The Generate page dialog's state machine, covering the four stateful-flow
// paths (knowledge-base/standards/stateful-flow-testing.md): forward,
// backtrack-and-revise, resume, re-entry after completion or failure.

import { beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_INPUTS,
  clearDraft,
  describeError,
  flowReducer,
  initialFlow,
  loadDraft,
  makeRequestKey,
  saveDraft,
  type FlowInputs,
  type FlowState,
} from '../flow';
import type { GenerationUndoRecord } from '../apply';

const inputs: FlowInputs = { brief: 'A bakery page', targetKind: 'newPage', model: 'SONNET', pageTitle: '' };
const record: GenerationUndoRecord = { kind: 'newPage', generationId: 'g1', pageId: 'p2', previousPageId: 'p1' };
const TARGET = 'page-1|';

function run(state: FlowState, key: string): FlowState {
  return flowReducer(state, { type: 'start', requestKey: key });
}

function applied(key = makeRequestKey(inputs, TARGET)): FlowState {
  let s = initialFlow(inputs);
  s = run(s, key);
  return flowReducer(s, { type: 'applied', requestKey: key, record, nodeCount: 12, warnings: ['w'] });
}

describe('forward', () => {
  it('editing -> running (progress) -> applied -> undone', () => {
    const key = makeRequestKey(inputs, TARGET);
    let s = run(initialFlow(inputs), key);
    expect(s.phase).toBe('running');
    s = flowReducer(s, { type: 'progress', requestKey: key, progress: { phase: 'generating', receivedChars: 3000, attempt: 1 } });
    expect(s.phase === 'running' && s.progress.receivedChars).toBe(3000);
    s = flowReducer(s, { type: 'applied', requestKey: key, record, nodeCount: 12, warnings: [] });
    expect(s).toMatchObject({ phase: 'applied', nodeCount: 12, undone: false });
    s = flowReducer(s, { type: 'undone' });
    expect(s).toMatchObject({ phase: 'applied', undone: true });
  });

  it('a failed undo keeps the result and shows why', () => {
    const s = flowReducer(applied(), { type: 'undoFailed', reason: 'already undone' });
    expect(s).toMatchObject({ phase: 'applied', undone: false, undoError: 'already undone' });
  });

  it('locks inputs while running', () => {
    const s = run(initialFlow(inputs), 'k');
    expect(flowReducer(s, { type: 'edit', inputs: { brief: 'other' }, targetKey: TARGET })).toBe(s);
    expect(run(s, 'k2')).toBe(s);
  });
});

describe('backtrack and revise', () => {
  it('changing the brief after a result drops the result and offers a fresh generation', () => {
    const s = flowReducer(applied(), { type: 'edit', inputs: { brief: 'A florist page' }, targetKey: TARGET });
    expect(s).toEqual({ phase: 'editing', inputs: { ...inputs, brief: 'A florist page' } });
  });

  it('changing the target (another component selected) drops the result', () => {
    const s = flowReducer(applied(), { type: 'edit', inputs: {}, targetKey: 'page-1|other-component' });
    expect(s.phase).toBe('editing');
  });

  it('changing the target kind or model drops the result', () => {
    expect(flowReducer(applied(), { type: 'edit', inputs: { targetKind: 'insert' }, targetKey: TARGET }).phase).toBe('editing');
    expect(flowReducer(applied(), { type: 'edit', inputs: { model: 'HAIKU' }, targetKey: TARGET }).phase).toBe('editing');
  });

  it('keeping the SAME inputs keeps the result (no gratuitous re-spend)', () => {
    const before = applied();
    const s = flowReducer(before, { type: 'edit', inputs: { brief: 'A bakery page ' }, targetKey: TARGET });
    expect(s.phase).toBe('applied');
  });

  it('a result for a cancelled run is ignored, it never lands on the new state', () => {
    const oldKey = makeRequestKey(inputs, TARGET);
    let s = run(initialFlow(inputs), oldKey);
    s = flowReducer(s, { type: 'cancel' });
    s = flowReducer(s, { type: 'edit', inputs: { brief: 'Something else' }, targetKey: TARGET });
    const newKey = makeRequestKey(s.inputs, TARGET);
    s = run(s, newKey);
    const late = flowReducer(s, { type: 'applied', requestKey: oldKey, record, nodeCount: 1, warnings: [] });
    expect(late).toBe(s);
    expect(flowReducer(s, { type: 'failed', requestKey: oldKey, error: { code: 'x', message: 'x' } })).toBe(s);
    expect(flowReducer(s, { type: 'progress', requestKey: oldKey, progress: { phase: 'validating', receivedChars: 1, attempt: 1 } })).toBe(s);
  });
});

describe('resume', () => {
  beforeEach(() => window.localStorage.clear());

  it('restores the draft inputs per project, never another project\'s', () => {
    saveDraft('proj-a', { ...inputs, targetKind: 'insert', pageTitle: 'Menu' });
    expect(loadDraft('proj-a')).toEqual({ ...inputs, targetKind: 'insert', pageTitle: 'Menu' });
    expect(loadDraft('proj-b')).toEqual(EMPTY_INPUTS);
  });

  it('discards a draft whose key does not match, a legacy shape, or garbage', () => {
    window.localStorage.setItem('framer-clone:page-gen-draft:proj-a', JSON.stringify({ v: 1, projectId: 'proj-b', inputs }));
    expect(loadDraft('proj-a')).toEqual(EMPTY_INPUTS);
    window.localStorage.setItem('framer-clone:page-gen-draft:proj-a', JSON.stringify({ brief: 'legacy' }));
    expect(loadDraft('proj-a')).toEqual(EMPTY_INPUTS);
    window.localStorage.setItem('framer-clone:page-gen-draft:proj-a', '{nope');
    expect(loadDraft('proj-a')).toEqual(EMPTY_INPUTS);
  });

  it('sanitises restored values', () => {
    window.localStorage.setItem(
      'framer-clone:page-gen-draft:proj-a',
      JSON.stringify({ v: 1, projectId: 'proj-a', inputs: { brief: 4, targetKind: 'nuke', model: 'OPUS' } }),
    );
    expect(loadDraft('proj-a')).toEqual(EMPTY_INPUTS);
  });

  it('a resumed dialog starts in editing with the draft, never with a run or result', () => {
    saveDraft('proj-a', inputs);
    const s = flowReducer(applied(), { type: 'reset', inputs: loadDraft('proj-a') });
    expect(s).toEqual({ phase: 'editing', inputs });
    clearDraft('proj-a');
    expect(loadDraft('proj-a')).toEqual(EMPTY_INPUTS);
  });
});

describe('re-entry after completion or failure', () => {
  it('re-opening after a completed generation starts clean', () => {
    const s = flowReducer(applied(), { type: 'reset', inputs: EMPTY_INPUTS });
    expect(s).toEqual(initialFlow());
  });

  it('a failure returns to editing with the inputs and the error; the next edit or run clears it', () => {
    const key = makeRequestKey(inputs, TARGET);
    let s = run(initialFlow(inputs), key);
    s = flowReducer(s, { type: 'failed', requestKey: key, error: { code: 'invalid_output', message: 'bad' } });
    expect(s).toEqual({ phase: 'editing', inputs, error: { code: 'invalid_output', message: 'bad' } });
    expect(flowReducer(s, { type: 'edit', inputs: {}, targetKey: TARGET })).toEqual({ phase: 'editing', inputs });
    const retried = run(s, key);
    expect(retried.phase).toBe('running');
    expect('error' in retried).toBe(false);
  });
});

describe('describeError', () => {
  it('turns codes into actionable messages and keeps validation details', () => {
    expect(describeError({ code: 'provider_unavailable', message: 'x' }).message).toMatch(/unavailable/);
    expect(describeError({ code: 'invalid_output', message: 'x', details: ['nodes[0]: bad'] })).toMatchObject({
      code: 'invalid_output',
      details: ['nodes[0]: bad'],
    });
    expect(describeError({ code: 'rate_limited', message: 'Wait 30 seconds.' }).message).toBe('Wait 30 seconds.');
    expect(describeError({ code: 'weird', message: 'raw' }).message).toBe('raw');
  });
});
