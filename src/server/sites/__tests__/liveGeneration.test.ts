// @vitest-environment node
//
// The running MCP generate_page's draft on the site bus (src/server/sites/liveGeneration.ts):
// what goes out and when, the one end per run, a second run superseding the first,
// the bounds, the scoped `state` snapshot and the expiry.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLiveBusForTests, subscribeSite } from '../liveBus';
import { generationSnapshot, openLiveGeneration, resetLiveGenerationForTests } from '../liveGeneration';
import { GEN_DRAFT_LIMITS } from '@/lib/projects/liveEvents';
import type { GeneratedNodeSnapshot } from '@/lib/ai/pageGen/validate';

const scope = { workspaceId: 'ws_a', tenantGroupId: 'tg_a' };
const other = { workspaceId: 'ws_b', tenantGroupId: 'tg_b' };

function node(text: string, id = `n-${text}`): GeneratedNodeSnapshot {
  return { id, type: 'section', componentType: 'host', props: { children: text }, children: [] } as unknown as GeneratedNodeSnapshot;
}

function listen(siteId = 'site-1') {
  const heard: Array<[string, Record<string, unknown>]> = [];
  subscribeSite(siteId, (event, data) => heard.push([event, data as Record<string, unknown>]));
  return heard;
}

beforeEach(() => {
  resetLiveBusForTests();
  resetLiveGenerationForTests();
});

describe('openLiveGeneration', () => {
  it('sends the outline and each section with the run and its target, and the state carries them', () => {
    const heard = listen();
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'insert', pageId: 'home', parentId: 'root' });
    run.outline({ generationId: 'run-1', attempt: 1, outline: [{ title: 'Hero', kind: 'hero' }, { title: '', kind: 'faq' }] });
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node: node('Hello') });
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node: node('Hello') }); // a repeat goes nowhere
    expect(heard.map(([event]) => event)).toEqual(['gen:outline', 'gen:section']);
    expect(heard[0][1]).toEqual({ runId: 'run-1', target: { kind: 'insert', pageId: 'home', parentId: 'root' }, outline: [{ title: 'Hero', kind: 'hero' }, { title: '', kind: 'faq' }] });
    expect(heard[1][1]).toMatchObject({ runId: 'run-1', index: 0, slot: 0, node: { props: { children: 'Hello' } } });
    // The generator's own id never travels: only the run's.
    expect(JSON.stringify(heard)).not.toContain('generationId');
    expect(generationSnapshot('site-1', scope)).toEqual({
      runId: 'run-1',
      target: { kind: 'insert', pageId: 'home', parentId: 'root' },
      outline: [{ title: 'Hero', kind: 'hero' }, { title: '', kind: 'faq' }],
      sections: [{ index: 0, slot: 0, node: node('Hello') }],
    });
  });

  it('never shows a run to a stream of another scope, nor sends on another site', () => {
    const elsewhere = listen('site-2');
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage' });
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node: node('A') });
    expect(generationSnapshot('site-1', other)).toBeUndefined();
    expect(generationSnapshot('site-1', scope)?.runId).toBe('run-1');
    expect(elsewhere).toEqual([]);
  });

  it("sanitises a new page's title and an outline's entries, whatever the generator sent", () => {
    const heard = listen();
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage', title: `Menu‮${'x'.repeat(100)}` });
    run.outline({ generationId: 'run-1', attempt: 1, outline: [{ title: 'A\u0000b', kind: 'nonsense' } as never, 7 as never] });
    const event = heard[0][1] as { target: { title: string }; outline: Array<{ title: string; kind: string }> };
    expect(event.target.title).not.toContain('‮');
    expect([...event.target.title].length).toBeLessThanOrEqual(60);
    expect(event.outline).toEqual([{ title: 'A b', kind: 'generic' }, { title: '', kind: 'generic' }]);
  });

  it('ends once: saved with the version, the ids and which drawn section each result section is', () => {
    const heard = listen();
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage' });
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node: node('Hero', 'p1') });
    run.section({ generationId: 'run-1', attempt: 1, index: 1, slot: 2, node: node('Old', 'p2') });
    // The result: the hero as drawn (other ids), a section the repair rewrote, a new one.
    run.end('saved', { version: 9, insertedIds: ['r1', 'r2', 'r3'], nodes: [node('Hero', 'x1'), node('New', 'x2'), node('Extra', 'x3')] });
    run.end('failed');
    run.section({ generationId: 'run-1', attempt: 1, index: 2, slot: 3, node: node('Late') });
    const done = heard.filter(([event]) => event === 'gen:done');
    expect(done).toEqual([['gen:done', { runId: 'run-1', status: 'saved', version: 9, insertedIds: ['r1', 'r2', 'r3'], drawnAs: [[0], [], []] }]]);
    expect(heard.at(-1)?.[0]).toBe('gen:done');
    expect(generationSnapshot('site-1', scope)).toBeUndefined();
  });

  it('names every identical preview a result section could be (the editor knows which it drew)', () => {
    const heard = listen();
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage' });
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node: node('Same', 'a') });
    run.section({ generationId: 'run-1', attempt: 1, index: 1, slot: 1, node: node('Same', 'b') });
    run.end('saved', { version: 2, insertedIds: ['r1'], nodes: [node('Same', 'c')] });
    expect(heard.at(-1)?.[1]).toMatchObject({ drawnAs: [[0, 1]] });
  });

  it('still ends a saved run when its details cannot be worked out', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const heard = listen();
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage' });
    // A value JSON cannot hold: matching the result against the previews throws.
    run.end('saved', { version: 5, insertedIds: ['r1'], nodes: [{ big: BigInt(1) } as unknown as GeneratedNodeSnapshot] });
    expect(heard).toEqual([['gen:done', { runId: 'run-1', status: 'saved', version: 5 }]]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('a failed or stopped run ends without a version, and the state forgets it', () => {
    const heard = listen();
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'replace', pageId: 'home', nodeId: 'hero' });
    run.end('stopped');
    expect(heard).toEqual([['gen:done', { runId: 'run-1', status: 'stopped' }]]);
    expect(generationSnapshot('site-1', scope)).toBeUndefined();
  });

  it('a second generation on the site supersedes the first, whose later steps and end go nowhere', () => {
    const heard = listen();
    const first = openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage' });
    first.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node: node('A') });
    const second = openLiveGeneration('site-1', scope, 'run-2', { kind: 'newPage' });
    first.section({ generationId: 'run-1', attempt: 1, index: 1, slot: 1, node: node('B') });
    first.end('saved', { version: 4, insertedIds: ['x'], nodes: [node('A')] });
    second.section({ generationId: 'run-2', attempt: 1, index: 0, slot: 0, node: node('C') });
    expect(heard.map(([event, data]) => [event, data.runId, data.status])).toEqual([
      ['gen:section', 'run-1', undefined],
      ['gen:done', 'run-1', 'superseded'],
      ['gen:section', 'run-2', undefined],
    ]);
    expect(generationSnapshot('site-1', scope)?.runId).toBe('run-2');
  });

  it('keeps the draft bounded: a section too large, past the run total or past the count is not sent', () => {
    const heard = listen();
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage' });
    const huge = node('x'.repeat(GEN_DRAFT_LIMITS.sectionChars), 'huge');
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node: huge });
    expect(heard).toEqual([]);
    // Sections just under the per-section cap until the run total is reached.
    const big = (i: number) => node(`${i}`.padEnd(GEN_DRAFT_LIMITS.sectionChars - 200, 'y'), `big-${i}`);
    let index = 1;
    while (index < 10) {
      run.section({ generationId: 'run-1', attempt: 1, index, slot: index, node: big(index) });
      index += 1;
    }
    const sent = heard.length;
    expect(sent).toBe(Math.floor(GEN_DRAFT_LIMITS.runChars / (GEN_DRAFT_LIMITS.sectionChars - 100)));
    const total = generationSnapshot('site-1', scope)!.sections.reduce((n, s) => n + JSON.stringify(s.node).length, 0);
    expect(total).toBeLessThanOrEqual(GEN_DRAFT_LIMITS.runChars);

    const small = openLiveGeneration('site-1', scope, 'run-2', { kind: 'newPage' });
    for (let i = 0; i < GEN_DRAFT_LIMITS.sectionsPerRun + 5; i += 1) small.section({ generationId: 'run-2', attempt: 1, index: i, slot: i, node: node(`s${i}`) });
    expect(generationSnapshot('site-1', scope)!.sections).toHaveLength(GEN_DRAFT_LIMITS.sectionsPerRun);
  });

  it('gives up on a run past its time, and on the least recently touched past the process bound', () => {
    const heard = listen();
    openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage' }, 1_000);
    expect(generationSnapshot('site-1', scope, 1_000 + GEN_DRAFT_LIMITS.runMaxMs + 1)).toBeUndefined();
    expect(heard).toEqual([['gen:done', { runId: 'run-1', status: 'expired' }]]);

    const now = Date.now();
    const evicted = listen('site-0');
    for (let i = 0; i <= GEN_DRAFT_LIMITS.runsPerProcess; i += 1) openLiveGeneration(`site-${i}`, scope, `run-${i}`, { kind: 'newPage' }, now);
    expect(generationSnapshot('site-0', scope, now)).toBeUndefined();
    expect(evicted).toEqual([['gen:done', { runId: 'run-0', status: 'expired' }]]);
    expect(generationSnapshot(`site-${GEN_DRAFT_LIMITS.runsPerProcess}`, scope, now)?.runId).toBe(`run-${GEN_DRAFT_LIMITS.runsPerProcess}`);
  });
});
