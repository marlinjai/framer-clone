// The words of the live agent canvas (src/lib/live/activityText.ts).

import { describe, expect, it } from 'vitest';
import { activityVerb, editingNote, feedLineText, presenceLabel } from '../activityText';

describe('activity words', () => {
  it('says what an agent does on the label', () => {
    expect(presenceLabel('Claude', 'apply_batch')).toBe('Claude · Editing');
    expect(presenceLabel('', 'get_page')).toBe('Agent · Reading');
    expect(activityVerb('generate_page')).toBe('Generating');
    expect(activityVerb('something_new')).toBe('Working');
  });

  it('writes feed lines in plain words, with the page title the editor knows', () => {
    expect(feedLineText({ tool: 'get_page', outcome: 'ok' }, 'Home')).toBe('Read the Home page');
    expect(feedLineText({ tool: 'get_page', outcome: 'ok' })).toBe('Read a page');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 4 }, 'Pricing')).toBe('Wrote 4 changes on Pricing');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'ok', changes: 1 })).toBe('Wrote 1 change');
    expect(feedLineText({ tool: 'generate_page', outcome: 'site_changed' })).toBe('Generation refused: site changed, re-reading');
    expect(feedLineText({ tool: 'apply_batch', outcome: 'rejected' })).toBe('Changes refused, nothing written');
    expect(feedLineText({ tool: 'publish', outcome: 'failed' })).toBe('Publishing failed');
    expect(feedLineText({ tool: 'publish', outcome: 'ok' })).toBe('Published the site');
  });

  it('names who edits in the top bar', () => {
    expect(editingNote([])).toBeNull();
    expect(editingNote(['Claude', 'Claude'])).toBe('Claude is editing this site');
    expect(editingNote(['Claude', 'Codex'])).toBe('Claude and Codex are editing this site');
    expect(editingNote(['a', 'b', 'c'])).toBe('3 agents are editing this site');
  });
});
