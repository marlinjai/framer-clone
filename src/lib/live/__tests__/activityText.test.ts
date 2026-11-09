// The words of the live agent canvas (src/lib/live/activityText.ts).

import { describe, expect, it } from 'vitest';
import {
  activityMode,
  activityVerb,
  editingNote,
  feedLineAnnouncement,
  feedLineText,
  followOffAnnouncement,
  followTitle,
  needsAttention,
  presenceLabel,
} from '../activityText';

const L = '\u2018';
const R = '\u2019';

describe('activity words', () => {
  it('says what an agent does on the label', () => {
    expect(presenceLabel('Claude', 'apply_batch')).toBe('Claude · Editing');
    expect(presenceLabel('', 'get_page')).toBe('Agent · Reading');
    expect(presenceLabel('Claude', 'announce_sections')).toBe('Claude · Planning');
    expect(presenceLabel('Claude', 'apply_batch', 'Pricing')).toBe('Claude · Writing Pricing');
    expect(activityVerb('generate_page')).toBe('Generating');
    expect(activityVerb('rollback')).toBe('Putting an earlier version live');
    expect(activityVerb('something_new')).toBe('Working');
  });

  it('uses "Planned" for every planned sections line, and names the agent that stopped', () => {
    expect(feedLineText({ tool: 'announce_sections', outcome: 'ok' }, 'Home')).toBe(`Planned sections on ${L}Home${R}`);
    expect(feedLineText({ tool: 'announce_sections', outcome: 'rejected' })).toBe('Planned sections refused, nothing written');
    expect(feedLineText({ tool: 'clear_sections', outcome: 'ok' })).toBe('Removed the planned sections');
    expect(feedLineText({ tool: 'clear_sections', outcome: 'failed' })).toBe('Removing the planned sections failed');
    expect(feedLineText({ tool: 'sections_stopped', outcome: 'ok', label: 'Claude' })).toBe('Planned sections removed: Claude stopped');
    expect(feedLineText({ tool: 'sections_stopped', outcome: 'ok' })).toBe('Planned sections removed: the agent stopped');
  });

  it('writes feed lines in plain words, with the page title the editor knows', () => {
    expect(feedLineText({ tool: 'get_page', outcome: 'ok' }, 'Home')).toBe(`Read the page ${L}Home${R}`);
    expect(feedLineText({ tool: 'get_page', outcome: 'ok' })).toBe('Read a page');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 4 }, 'Pricing')).toBe(`Wrote 4 changes on ${L}Pricing${R}`);
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 1 })).toBe('Wrote 1 change');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok' })).toBe('Edited the site');
    expect(feedLineText({ tool: 'publish', outcome: 'ok' })).toBe('Published the site');
    expect(feedLineText({ tool: 'rollback', outcome: 'ok' })).toBe('Put an earlier version live');
  });

  it('words refusals, approvals and failures without jargon', () => {
    expect(feedLineText({ tool: 'generate_page', outcome: 'site_changed' })).toBe('Generated content not saved: the site changed meanwhile');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'site_changed' })).toBe('Changes not written: the site changed meanwhile');
    expect(feedLineText({ tool: 'publish', outcome: 'site_changed' })).toBe('Publishing stopped: the site changed meanwhile');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'rejected' })).toBe('Changes refused, nothing written');
    expect(feedLineText({ tool: 'publish', outcome: 'failed' })).toBe('Publishing failed');
    expect(feedLineText({ tool: 'publish', outcome: 'awaiting_approval' })).toBe('Publishing needs your approval');
    expect(feedLineText({ tool: 'rollback', outcome: 'declined' })).toBe('Putting an earlier version live declined, nothing changed');
    expect(feedLineText({ tool: 'unknown_tool', outcome: 'failed' })).toBe('A step failed');
  });

  it('names a deleted page by the title the editor remembers, and words a mixed batch', () => {
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 1, pageId: 'p2', deletedPageIds: ['p2'] }, 'About', ['About'])).toBe(`Deleted the page ${L}About${R}`);
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 1, deletedPageIds: ['p2'] })).toBe('Deleted a page');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 2, deletedPageIds: ['p2', 'p3'] }, undefined, ['A', 'B'])).toBe('Deleted 2 pages');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 5, pageId: 'p1', deletedPageIds: ['p2'] }, 'Home')).toBe(`Wrote 4 changes on ${L}Home${R} and deleted 1 page`);
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 5, deletedPageIds: ['p2'] }, undefined, ['About'])).toBe(`Wrote 4 changes and deleted the page ${L}About${R}`);
    // The line's own page is the deleted one: no "on" for it.
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 3, pageId: 'p2', deletedPageIds: ['p2'] }, 'About')).toBe('Wrote 2 changes and deleted 1 page');
    // More deletes than ids travel: the uncapped count decides.
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 30, deletedPageIds: ['p1', 'p2'], deletedPages: 30 })).toBe('Deleted 30 pages');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 31, deletedPageIds: ['p1'], deletedPages: 30 })).toBe('Wrote 1 change and deleted 30 pages');
    // A refused batch is a refusal, whatever it names.
    expect(feedLineText({ tool: 'apply_batch', outcome: 'rejected', changes: 1, deletedPageIds: ['p2'] })).toBe('Changes refused, nothing written');
  });

  it('says in the top bar whether the agents read or edit', () => {
    const a = (label: string, tool = 'apply_batch') => ({ label, tool });
    expect(editingNote([])).toBeNull();
    expect(editingNote([a('Claude', 'get_page')])).toBe('Claude is reading this site');
    expect(editingNote([a('Claude')])).toBe('Claude is editing this site');
    // Planning sections writes nothing to the site yet.
    expect(editingNote([a('Claude', 'announce_sections')])).toBe('Claude is planning changes to this site');
    expect(editingNote([a('Claude', 'get_page'), a('Codex', 'clear_sections')])).toBe('Claude and Codex are planning changes to this site');
    expect(activityMode([a('Claude', 'announce_sections')])).toBe('planning');
    // Publishing changes what visitors see, never the copy the person edits: no conflict follows.
    expect(editingNote([a('Claude', 'publish')])).toBe('Claude is changing what visitors see');
    expect(activityMode([a('Claude', 'rollback')])).toBe('publishing');
    expect(activityMode([a('Claude', 'publish'), a('Codex', 'apply_batch')])).toBe('editing');
    expect(editingNote([a('Claude'), a('Claude')])).toBe('2 agents are editing this site');
    expect(editingNote([a('Claude'), a('Claude'), a('Codex'), a('')])).toBe('4 agents are editing this site');
    expect(editingNote([a(''), a('')])).toBe('2 agents are editing this site');
    expect(editingNote([a('Claude', 'get_site'), a('Codex', 'get_page')])).toBe('Claude and Codex are reading this site');
    expect(editingNote([a('Claude', 'get_site'), a('Codex')])).toBe('Claude and Codex are editing this site');
    expect(activityMode([])).toBeUndefined();
    expect(activityMode([a('Claude', 'get_page')])).toBe('reading');
    expect(activityMode([a('Claude', 'get_page'), a('Codex', 'publish')])).toBe('publishing');
    // Once it wrote in this run, it stays "editing" while it reads in between.
    expect(activityMode([a('Claude', 'get_page')], true)).toBe('editing');
    expect(editingNote([a('Claude', 'get_page')], true)).toBe('Claude is editing this site');
  });

  it('announces only what needs attention, with the agent first', () => {
    expect(needsAttention({ outcome: 'ok' })).toBe(false);
    expect(needsAttention({ outcome: 'awaiting_approval' })).toBe(true);
    expect(needsAttention({ outcome: 'site_changed' })).toBe(false);
    expect(feedLineAnnouncement({ tool: 'publish', outcome: 'awaiting_approval', label: 'Claude' })).toBe('Claude: Publishing needs your approval');
    expect(feedLineAnnouncement({ tool: 'publish', outcome: 'failed' })).toBe('Agent: Publishing failed');
  });

  it('names the agent the camera follows', () => {
    expect(followOffAnnouncement('Claude')).toBe('Stopped following Claude. Turn Follow back on to follow again.');
    expect(followOffAnnouncement(undefined)).toBe('Stopped following the agent. Turn Follow back on to follow again.');
    expect(followTitle(true, 'Claude')).toBe('The canvas follows Claude');
    expect(followTitle(false, undefined)).toBe('Follow the agent on the canvas');
  });
});

describe('capped stream text', () => {
  it('stays bounded in size whatever one character carries', async () => {
    const { capLiveText, LIVE_LABEL_MAX } = await import('@/lib/projects/liveEvents');
    const capped = capLiveText('x' + '́'.repeat(100_000));
    expect(Array.from(capped).length).toBeLessThanOrEqual(8);
    const long = capLiveText('\u{1f1e9}\u{1f1ea}'.repeat(200));
    expect(Array.from(long).length).toBeLessThanOrEqual(LIVE_LABEL_MAX * 2 + 1);
    expect(long.endsWith('…')).toBe(true);
  });
});
