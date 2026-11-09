// The page titles this editor saw (../pageTitleMemory.ts).

import { describe, expect, it } from 'vitest';
import { forgetPageTitles, rememberedPageTitle, rememberPageTitles } from '../pageTitleMemory';
import { LivePresenceStore } from '../presenceStore';

describe('page title memory', () => {
  it('keeps the last title seen per project, skips blank ones, and forgets them all on a reset', () => {
    rememberPageTitles({ id: 's1' }, [{ id: 'p1', metadata: { title: 'About' } }, { id: 'p2', metadata: { title: '  ' } }]);
    rememberPageTitles({ id: 's1' }, [{ id: 'p1', metadata: { title: 'About us' } }]);
    expect(rememberedPageTitle({ id: 's1' }, 'p1')).toBe('About us');
    expect(rememberedPageTitle({ id: 's1' }, 'p2')).toBeUndefined();
    expect(rememberedPageTitle({ id: 's2' }, 'p1')).toBeUndefined();
    new LivePresenceStore().reset();
    expect(rememberedPageTitle({ id: 's1' }, 'p1')).toBeUndefined();
    forgetPageTitles();
  });
});
