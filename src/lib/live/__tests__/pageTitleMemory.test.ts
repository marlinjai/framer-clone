// The page titles this editor saw (../pageTitleMemory.ts).

import { describe, expect, it } from 'vitest';
import { forgetPageTitles, PAGE_TITLES_MAX, rememberedPageTitle, rememberPageTitles } from '../pageTitleMemory';
import { LivePresenceStore } from '../presenceStore';

describe('page title memory', () => {
  it('keeps the last title seen per project, skips blank ones, and forgets them all on a reset', () => {
    rememberPageTitles({ id: 's1' }, [{ id: 'p1', metadata: { title: 'About' } }, { id: 'p2', metadata: { title: '  ' } }]);
    rememberPageTitles({ id: 's1' }, [{ id: 'p1', metadata: { title: 'About us' } }]);
    expect(rememberedPageTitle({ id: 's1' }, 'p1')).toBe('About us');
    expect(rememberedPageTitle({ id: 's1' }, 'p2')).toBeUndefined();
    expect(rememberedPageTitle({ id: 's2' }, 'p1')).toBeUndefined();
    // A title cleared later is forgotten, not kept stale.
    rememberPageTitles({ id: 's1' }, [{ id: 'p1', metadata: { title: '' } }]);
    expect(rememberedPageTitle({ id: 's1' }, 'p1')).toBeUndefined();
    rememberPageTitles({ id: 's1' }, [{ id: 'p1', metadata: { title: 'About us' } }]);
    new LivePresenceStore().reset();
    expect(rememberedPageTitle({ id: 's1' }, 'p1')).toBeUndefined();
    forgetPageTitles();
  });

  it('keeps at most PAGE_TITLES_MAX titles per project, the most recently seen', () => {
    const pages = Array.from({ length: PAGE_TITLES_MAX + 10 }, (_, i) => ({ id: `p${i}`, metadata: { title: `Page ${i}` } }));
    rememberPageTitles({ id: 's9' }, pages);
    expect(rememberedPageTitle({ id: 's9' }, 'p0')).toBeUndefined();
    expect(rememberedPageTitle({ id: 's9' }, `p${PAGE_TITLES_MAX + 9}`)).toBe(`Page ${PAGE_TITLES_MAX + 9}`);
    forgetPageTitles();
  });
});
