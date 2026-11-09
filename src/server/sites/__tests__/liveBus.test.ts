// The in-process bus of a site's live events (src/server/sites/liveBus.ts) and
// the bounds a write event gets before it travels (src/lib/projects/liveEvents.ts).
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { acquireStreamSlot, LIVE_STREAM_LIMITS, publishSiteEvent, resetLiveBusForTests, subscribeSite } from '../liveBus';
import { boundedWriteEvent, capLiveText, LIVE_LABEL_MAX, LIVE_LIST_MAX } from '@/lib/projects/liveEvents';

beforeEach(() => resetLiveBusForTests());

describe('liveBus', () => {
  it("delivers a site's events to its listeners only, and a broken listener never stops the others", () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const heard: unknown[] = [];
    subscribeSite('a', () => {
      throw new Error('broken');
    });
    const off = subscribeSite('a', (event, data) => heard.push([event, data]));
    subscribeSite('b', () => heard.push('wrong site'));
    publishSiteEvent('a', 'site:version', { version: 2 });
    expect(heard).toEqual([['site:version', { version: 2 }]]);
    expect(errorSpy).toHaveBeenCalled();
    off();
    publishSiteEvent('a', 'site:version', { version: 3 });
    expect(heard).toHaveLength(1);
    errorSpy.mockRestore();
  });

  it('counts stream slots per session, per site and per process, and a release is idempotent', () => {
    const releases = Array.from({ length: LIVE_STREAM_LIMITS.perSession }, () => acquireStreamSlot('a', 's1', 'c1')!);
    expect(acquireStreamSlot('a', 's1', 'c1')).toBeNull();
    expect(acquireStreamSlot('b', 's1', 'c1')).toBeNull(); // the session bound spans sites
    releases[0]();
    releases[0]();
    const again = acquireStreamSlot('a', 's1', 'c1');
    expect(again).not.toBeNull();
    expect(acquireStreamSlot('a', 's1', 'c1')).toBeNull();
  });

  it("bounds one company's share of the process, and another company still gets a slot", () => {
    const { perCompany, perSession, perSite } = LIVE_STREAM_LIMITS;
    const releases: Array<() => void> = [];
    // Spread over sessions and sites so only the company bound is reached.
    for (let i = 0; i < perCompany; i++) {
      const slot = acquireStreamSlot(`site${Math.floor(i / perSite)}`, `s${Math.floor(i / perSession)}`, 'busy');
      expect(slot).not.toBeNull();
      releases.push(slot!);
    }
    expect(acquireStreamSlot('fresh-site', 'fresh-session', 'busy')).toBeNull();
    expect(acquireStreamSlot('fresh-site', 'fresh-session', 'other')).not.toBeNull();
    releases[0]();
    expect(acquireStreamSlot('fresh-site', 'another-session', 'busy')).not.toBeNull();
  });
});

describe('boundedWriteEvent', () => {
  it('caps labels and summary lines to one plain line, and bounds the lists', () => {
    const long = 'x'.repeat(200);
    const out = boundedWriteEvent({
      origin: 'mcp',
      actor: { kind: 'key', label: `Agent\n${long}` },
      ops: Array.from({ length: LIVE_LIST_MAX + 5 }, () => ({ op: 'updateText', nodeId: 'n' })),
      created: Object.fromEntries(Array.from({ length: LIVE_LIST_MAX + 5 }, (_, i) => [`r${i}`, `n${i}`])),
      summary: [`line\nbreak ${long}`],
    });
    expect(out.actor!.label.length).toBeLessThanOrEqual(LIVE_LABEL_MAX);
    expect(out.summary![0]).not.toContain('\n');
    expect(out.summary![0].length).toBeLessThanOrEqual(LIVE_LABEL_MAX);
    expect(out.ops).toHaveLength(LIVE_LIST_MAX);
    expect(Object.keys(out.created!)).toHaveLength(LIVE_LIST_MAX);
    // A ref an agent chose is capped like any text.
    expect(Object.keys(boundedWriteEvent({ origin: 'mcp', created: { [long]: 'n1' } }).created!)[0].length).toBeLessThanOrEqual(LIVE_LABEL_MAX);
    expect(capLiveText('  a\n  b  ')).toBe('a b');
    expect(boundedWriteEvent({ origin: 'editor', actor: { kind: 'user', label: '   ' } }).actor!.label).toBe('Someone');
  });

  it('strips bidirectional overrides and invisible characters from the actor label and the summary lines', () => {
    const out = boundedWriteEvent({
      origin: 'mcp',
      actor: { kind: 'key', label: 'Bot\u202Egnp.exe\u200B' },
      summary: ['Page \u2066Home\u2069 changed', '\u202E\u200B'],
    });
    expect(out.actor!.label).toBe('Bot gnp.exe');
    expect(out.summary).toEqual(['Page Home changed']);
    expect(boundedWriteEvent({ origin: 'mcp', actor: { kind: 'key', label: '\u202E' } }).actor!.label).toBe('Someone');
  });
});
