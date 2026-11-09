// @vitest-environment node
//
// The running MCP generate_page's draft on the site bus (src/server/sites/liveGeneration.ts):
// what goes out and when, the one end per run, a second run superseding the first,
// the bounds, the scoped `state` snapshot and the expiry.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetLiveBusForTests, subscribeSite } from '../liveBus';
import { endLiveGenerationOfSite, generationSnapshot, openLiveGeneration, resetLiveGenerationForTests } from '../liveGeneration';
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
    // One run per company: the process bound gives up the least recently touched, whoever's it is.
    for (let i = 0; i <= GEN_DRAFT_LIMITS.runsPerProcess; i += 1) openLiveGeneration(`site-${i}`, { workspaceId: `ws_${i}`, tenantGroupId: `tg_${i}` }, `run-${i}`, { kind: 'newPage' }, now);
    expect(generationSnapshot('site-0', { workspaceId: 'ws_0', tenantGroupId: 'tg_0' }, now)).toBeUndefined();
    expect(evicted).toEqual([['gen:done', { runId: 'run-0', status: 'expired' }]]);
    const last = GEN_DRAFT_LIMITS.runsPerProcess;
    expect(generationSnapshot(`site-${last}`, { workspaceId: `ws_${last}`, tenantGroupId: `tg_${last}` }, now)?.runId).toBe(`run-${last}`);
  });

  it('past the process bound, the company holding the most runs gives up its oldest one', () => {
    const now = Date.now();
    const busy = { workspaceId: 'ws_busy', tenantGroupId: 'tg_busy' };
    const lonely = listen('lonely');
    openLiveGeneration('lonely', other, 'run-lonely', { kind: 'newPage' }, now);
    const busyFirst = listen('busy-0');
    for (let i = 0; i < GEN_DRAFT_LIMITS.runsPerCompany; i += 1) openLiveGeneration(`busy-${i}`, busy, `busy-${i}`, { kind: 'newPage' }, now);
    for (let i = 0; GEN_DRAFT_LIMITS.runsPerCompany + 1 + i < GEN_DRAFT_LIMITS.runsPerProcess; i += 1) {
      openLiveGeneration(`solo-${i}`, { workspaceId: `ws_s${i}`, tenantGroupId: `tg_s${i}` }, `solo-${i}`, { kind: 'newPage' }, now);
    }
    // One more company arrives with the process full.
    openLiveGeneration('newcomer', { workspaceId: 'ws_new', tenantGroupId: 'tg_new' }, 'run-new', { kind: 'newPage' }, now);
    expect(busyFirst).toEqual([['gen:done', { runId: 'busy-0', status: 'expired' }]]);
    expect(lonely).toEqual([]);
    expect(generationSnapshot('lonely', other, now)?.runId).toBe('run-lonely');
  });

  it("a company over its share gives up its own oldest run, never another company's", () => {
    const now = Date.now();
    openLiveGeneration('other-site', other, 'run-other', { kind: 'newPage' }, now);
    const first = listen('busy-0');
    for (let i = 0; i <= GEN_DRAFT_LIMITS.runsPerCompany; i += 1) openLiveGeneration(`busy-${i}`, scope, `busy-run-${i}`, { kind: 'newPage' }, now);
    expect(first).toEqual([['gen:done', { runId: 'busy-run-0', status: 'expired' }]]);
    expect(generationSnapshot('busy-1', scope, now)?.runId).toBe('busy-run-1');
    expect(generationSnapshot('other-site', other, now)?.runId).toBe('run-other');
  });
});

describe('a run given up on by the clock, and one ended from outside', () => {
  it('expires on its own clock, clears what it kept, sends nothing more, and never touches a newer run', () => {
    vi.useFakeTimers();
    try {
      const heard = listen();
      const run = openLiveGeneration('site-1', scope, 'run-old', { kind: 'newPage' });
      run.section({ generationId: 'run-old', attempt: 1, index: 0, slot: 0, node: node('Old') });
      vi.advanceTimersByTime(GEN_DRAFT_LIMITS.runMaxMs + 1);
      expect(heard.map(([event, data]) => [event, data.status])).toContainEqual(['gen:done', 'expired']);
      expect(generationSnapshot('site-1', scope)).toBeUndefined();
      const before = heard.length;
      run.section({ generationId: 'run-old', attempt: 1, index: 1, slot: 1, node: node('Late') });
      expect(heard.length).toBe(before);
      // A run opened later keeps its own clock: the first one's timer is gone.
      const next = openLiveGeneration('site-1', scope, 'run-new', { kind: 'newPage' });
      vi.advanceTimersByTime(GEN_DRAFT_LIMITS.runMaxMs - 1000);
      expect(generationSnapshot('site-1', scope)?.runId).toBe('run-new');
      next.end('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('endLiveGenerationOfSite ends the run once, drops its content and stops its later previews', () => {
    const heard = listen();
    const run = openLiveGeneration('site-1', scope, 'run-1', { kind: 'newPage' });
    run.section({ generationId: 'run-1', attempt: 1, index: 0, slot: 0, node: node('Hello') });
    endLiveGenerationOfSite('site-1', 'site_changed');
    endLiveGenerationOfSite('site-1', 'site_changed');
    run.section({ generationId: 'run-1', attempt: 1, index: 1, slot: 1, node: node('After') });
    expect(heard.filter(([event]) => event === 'gen:done')).toEqual([['gen:done', { runId: 'run-1', status: 'site_changed' }]]);
    expect(heard.filter(([event]) => event === 'gen:section')).toHaveLength(1);
    expect(generationSnapshot('site-1', scope)).toBeUndefined();
  });
});
