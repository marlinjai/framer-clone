// The agent's generate_page draft in the editor (src/lib/live/generationDraft.ts): which targets it accepts.
import { describe, expect, it } from 'vitest';
import { GenerationDraft } from '../generationDraft';

function make() {
  return new GenerationDraft({
    draft: () => undefined,
    project: () => undefined,
    currentPageId: () => undefined,
    knownVersion: () => 1,
    setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
    clearTimer: () => undefined,
  });
}

describe('GenerationDraft targets', () => {
  it.each([
    [{ kind: 'insert', pageId: 'page.home', parentId: 'root:home' }],
    [{ kind: 'replace', pageId: 'p:1', nodeId: 'node.a-b' }],
    [{ kind: 'insert', pageId: 'home', parentId: 'root' }],
  ])('follows a run whose target uses persisted ids (%j)', (target) => {
    const draft = make();
    draft.applyOutline({ runId: 'run-1', target: target as never, outline: [] });
    expect(draft.runId).toBe('run-1');
  });

  it.each([
    [{ kind: 'insert', pageId: 'has space', parentId: 'root' }],
    [{ kind: 'insert', pageId: 'home', parentId: '' }],
    [{ kind: 'replace', pageId: 'home', nodeId: 'x'.repeat(201) }],
    [{ kind: 'insert', pageId: 'ho\nme', parentId: 'root' }],
  ])('ignores a run whose target ids are not persisted ids (%j)', (target) => {
    const draft = make();
    draft.applyOutline({ runId: 'run-1', target: target as never, outline: [] });
    expect(draft.runId).toBeUndefined();
  });
});
